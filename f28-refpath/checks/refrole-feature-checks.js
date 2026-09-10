#!/usr/bin/env node
'use strict';
//
// F28 REFERENCE ROLES — the feature, in the packaged application.
//
//   node f28-refpath/checks/refrole-feature-checks.js
//
// Row 8 of `project-notes/F28_CHILD_CONTEXT_SPEC.md` §1, measured by the
// child-context baseline and deliberately left unfixed by that slice:
//
//   "a counted reference and a child under it are drawn identically — same
//    classes, same bullet. The only difference is `data-refs-self`, which is
//    not visible."
//
// This run establishes what one inert word per row adds, ON THE SAME FIXTURE
// the child-context slices used, and that everything both earlier runs observed
// as working still works.
//
// WHY THE SAME FIXTURE. `make-refctx-graph.js` already contains the case this
// feature turns on: `mixedRef` names the anchor page AND is a child of `mixed`,
// which also names it, so OG draws it TWICE in one list — once as its own
// counted result and once as context under its parent. A child that also
// mentions the page must never be labelled context-only, and that is the block
// that proves it. Building a second graph to say the same thing would add a
// fixture, not evidence.
//
// MANDATORY GRAPH-DATA BOUNDARY (project-notes/DATA_ACCESS_GUARDRAIL.md).
// Graph data is only ever this run's own fresh synthetic graph inside
// ~/Library/Mobile Documents/com~apple~CloudDocs/Logseq Test. No personal graph
// is opened, read or enumerated, no earlier run's folder is touched, and the
// installed application is never launched. The loaded graph path is asserted
// BEFORE any feature interaction. This run writes nothing to the graph and
// proves it by comparing every file's hash after the application has closed.
//
// ONE THING THIS RUN DELIBERATELY DOES NOT DO. It does not APPLY a linked-
// references filter. `page-handler/save-filter!` persists the choice as a
// `filters::` property in the page FILE, which is a graph write, and this run
// must make none. The filter's dialog is opened and dismissed — a real redraw
// of the section — and the role assignment is compared across it. Include and
// exclude semantics themselves are unexercised here and are recorded as a limit
// rather than implied.
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
const FEATURE_APP = 'Logseq-OG-F28-RefPath';

const results = [];
let ownedTree = [];
const errors = REC.createRecorder();
const observations = {};
let errorEvidence = null;
const sleep = OP.sleep;
const U = RG.UUID;

// The blocks that name the anchor page themselves. `references*` selects
// exactly these into `top-level-blocks` and counts them into the heading, so
// this is also the set that must carry the DIRECT label — wherever each one is
// drawn.
const DIRECT = RG.REFERENCING;
const DIRECT_IDS = new Set(DIRECT.map((k) => U[k]));

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

async function main() {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  say('\n=== F28 reference roles: which rows are mentions, and which are their surroundings ===\n');

  // ---------- P0 : preconditions ----------
  say('P0  preconditions');
  const built = APP.resolve(FEATURE_APP);
  const v = built.preflight;
  record('P0.1', 'this build is present and passes its identity check', v.ok,
    v.ok ? `${built.appName}: build ${v.manifest.pilotBuildId}, renderer ` +
           `${v.manifest.builtFrom.rendererRevision}, branch ${v.manifest.builtFrom.branch}`
         : `${v.reason}: ${v.detail}`);
  if (!v.ok) throw new Error('preflight failed');
  observations.build = {
    app: built.appName,
    schema: v.manifest.schema,
    branch: v.manifest.builtFrom.branch,
    commit: v.manifest.builtFrom.commit,
    dirty: v.manifest.builtFrom.dirty,
    renderer: v.manifest.builtFrom.rendererRevision,
    buildId: v.manifest.pilotBuildId,
  };
  const runtime = path.join(built.resApp, 'js', 'cljs-runtime');
  const names = fs.existsSync(runtime) ? fs.readdirSync(runtime) : [];
  record('P0.2', 'the packaged renderer really carries this feature',
    names.includes('frontend.util.f28_refrole.js'),
    `f28_refrole ${names.includes('frontend.util.f28_refrole.js')}, ` +
    `f28_refctx ${names.includes('frontend.util.f28_refctx.js')}, ` +
    `f28_refpath ${names.includes('frontend.util.f28_refpath.js')}`);
  // The compiled renderer must carry the DECISION, not merely a namespace with
  // the right name. A dictionary entry or a CSS class proves neither.
  let compiled = '';
  for (const f of names.filter((n) => n.startsWith('frontend.util.f28_refrole'))) {
    compiled += fs.readFileSync(path.join(runtime, f), 'utf8');
  }
  record('P0.3', 'and carries the predicate itself, compiled',
    /direct_mention_QMARK_/.test(compiled) && /row_role/.test(compiled) &&
    /page_ids/.test(compiled),
    `direct-mention? ${/direct_mention_QMARK_/.test(compiled)}, ` +
    `row-role ${/row_role/.test(compiled)}, page-ids ${/page_ids/.test(compiled)} ` +
    `(${compiled.length} bytes of compiled namespace)`);

  // ---------- P1 : a fresh graph ----------
  say('\nP1  a fresh synthetic graph; nothing in this run writes to it');
  const g = RG.build({ kind: 'refrole' });
  const GRAPH = B.assertInsideAllowedRoot('refrole graph', g.graph);
  record('P1.1', 'created fresh inside the permitted root; no earlier run reused or touched', true,
    `${GRAPH} (${g.pages} pages + ${g.journal} + ${g.asset})`);
  const before = GH.snapshot(GRAPH);
  const controlBefore = RG.readPage(GRAPH, RG.CONTROL_FILE);
  record('P1.2', 'every file hashed before the application is launched',
    Object.keys(before).length >= g.pages + 2, `${Object.keys(before).length} files`);
  const BAD = path.join(path.dirname(B.allowedRootReal()), 'f28-refrole-inert-probe');
  record('P1.3', 'the bad-dialog probe path is outside the permitted root and inert',
    !B.isInsideAllowedRoot(BAD) && !fs.existsSync(BAD), BAD);

  // ---------- P2/P3 : launch, refuse, then open ----------
  const session = await APP.open({
    built, graph: GRAPH, bad: BAD, errors, say, record, phase, prefix: 'P',
  });
  const { page, goTo, parkPointer } = session;
  ownedTree = session.ownedTree;

  try {
    const settle = async (why) => {
      let seen = -1;
      let stable = 0;
      for (let i = 0; i < 24 && stable < 3; i++) {
        await page.evaluate((step) => {
          const m = document.querySelector('#main-content-container') || document.body;
          const max = m.scrollHeight - m.clientHeight;
          m.scrollTop = max > 0 ? Math.min(max, (step % 6) * (max / 5)) : 0;
          window.scrollTo(0, (step % 6) * (document.body.scrollHeight / 5));
        }, i).catch(() => null);
        await sleep(1300);
        const n = await page.evaluate(() =>
          document.querySelectorAll('.references.page-linked .ls-block[blockid]').length)
          .catch(() => 0);
        if (n === seen) stable += 1; else { seen = n; stable = 0; }
      }
      await parkPointer();
      say(`          (settled at ${seen} rows${why ? ` ${why}` : ''})`);
      return seen;
    };

    /**
     * One reading of the section. Every row, the role label attached to THAT
     * row, and what the section as a whole is doing.
     *
     * `:scope >` throughout: a label belongs to the row whose own main
     * container holds it, never to an ancestor row that happens to contain it.
     */
    const read = () => page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const sec = document.querySelector('.references.page-linked');
      if (!sec) return { present: false };
      const rows = [...sec.querySelectorAll('.ls-block[blockid]')];
      const index = new Map(rows.map((el, i) => [el, i]));
      const readRow = (el, i) => {
        const main = el.querySelector(':scope > .block-main-container');
        let p = el.parentElement;
        let parent = null;
        while (p && p !== sec) {
          if (p.classList && p.classList.contains('ls-block') && p.hasAttribute('blockid')) {
            parent = index.has(p) ? index.get(p) : null; break;
          }
          p = p.parentElement;
        }
        const labels = main ? [...main.querySelectorAll(':scope > .f28-role')] : [];
        const label = labels[0] || null;
        return {
          i,
          id: el.getAttribute('blockid'),
          parent,
          text: clean(main ? main.innerText : '').slice(0, 90),
          level: el.getAttribute('level'),
          hasChildAttr: el.getAttribute('haschild'),
          collapsedAttr: el.getAttribute('data-collapsed'),
          // OG's own invisible marker, kept beside the visible one so the two
          // can be compared rather than assumed to agree.
          refsSelf: el.getAttribute('data-refs-self'),
          labels: labels.length,
          role: label ? label.getAttribute('data-f28-role') : null,
          roleText: label ? clean(label.innerText) : null,
          roleTitle: label ? label.getAttribute('title') : null,
          roleTag: label ? label.tagName : null,
          roleTabIndex: label ? label.getAttribute('tabindex') : null,
          roleHref: label ? label.getAttribute('href') : null,
          roleRole: label ? label.getAttribute('role') : null,
          roleInteractive: label
            ? label.querySelectorAll('button, a, input, [tabindex], [contenteditable]').length
            : 0,
          ctxControl: !!el.querySelector(':scope > .f28-ctx > .f28-ctx-open'),
          ctxPanelLabels: el.querySelector(':scope > .f28-ctx > .f28-ctx-panel')
            ? el.querySelector(':scope > .f28-ctx > .f28-ctx-panel')
                .querySelectorAll('.f28-role').length
            : null,
        };
      };
      const all = rows.map(readRow);
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
      // Everything in the section a keyboard can stop on. The role labels must
      // add none of them.
      const focusables = [...sec.querySelectorAll(
        'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])')];
      return {
        present: true,
        heading: clean((sec.querySelector('h2') || {}).innerText),
        items,
        rows: all,
        labels: sec.querySelectorAll('.f28-role').length,
        labelsInsideLabels: sec.querySelectorAll('.f28-role .f28-role').length,
        focusable: focusables.length,
        focusableRoles: focusables.filter((e) => e.closest('.f28-role')).length,
        ctxControls: sec.querySelectorAll('.f28-ctx-open').length,
        filterControl: !!sec.querySelector('a.filter'),
        unlinked: !!document.querySelector('.references.page-unlinked'),
        editors: sec.querySelectorAll('textarea').length,
        sectionText: sec.innerText || '',
      };
    }).catch((e) => ({ present: false, error: String(e.message) }));

    const lean = (r) => JSON.parse(JSON.stringify({ ...r, sectionText: undefined }));
    const rowsOf = (r, key) => r.rows.filter((x) => x.id === U[key]);
    const rowOf = (r, key) => rowsOf(r, key)[0];
    /** The role assignment as a comparable value: one entry per appearance. */
    const assignment = (r) => r.rows.map((x) => `${x.i}:${x.id}=${x.role}`).join('|');

    // ---------- P4 : OG's own list, unchanged ----------
    say('\nP4  OG\'s own list, unchanged by this feature');
    phase('read-linked-references', 'open-the-anchor-page');
    await goTo(RG.ANCHOR);
    await settle('on the anchor page');
    const refs = await read();
    observations.feature = refs.present ? lean(refs) : refs;
    record('P4.1', 'the linked-references section rendered', refs.present === true,
      refs.present ? refs.heading : `not present: ${refs.error}`);
    if (!refs.present) throw new Error('no linked-references section; not proceeding');

    record('P4.2', 'the reference count still counts mentions, not rows',
      refs.heading.includes(String(DIRECT.length)),
      `"${refs.heading}" for ${DIRECT.length} referencing block(s), ` +
      `${refs.rows.length} row(s) drawn`);
    record('P4.3', 'every referencing block is still listed, still grouped by source page',
      DIRECT.every((k) => !!rowOf(refs, k)) && refs.items.length === 5,
      `${DIRECT.filter((k) => !!rowOf(refs, k)).length}/${DIRECT.length} located across ` +
      `${refs.items.length} source page(s): ` +
      JSON.stringify(refs.items.map((i) => i.page)));
    record('P4.4', 'the breadcrumbs are exactly what OG drew: complete, and none elided',
      refs.items.every((i) => i.groups.every((gp) => gp.more === 0)),
      `${refs.items.reduce((n, i) => n + i.groups.length, 0)} group(s), 0 "⋯" markers`);
    record('P4.5', 'the children OG already drew are still drawn, whole',
      Object.entries(RG.CHILDREN).every(([key, want]) =>
        rowsOf(refs, key).length > 0 &&
        rowsOf(refs, key).every((row) => {
          const sub = (function walk(rw) {
            const kids = refs.rows.filter((x) => x.parent === rw.i);
            return kids.flatMap((k) => [k, ...walk(k)]);
          })(row);
          return sub.length === want.ogShows;
        })),
      Object.entries(RG.CHILDREN).map(([k, w]) => `${k}:${w.ogShows}`).join(' '));
    record('P4.6', "OG's filter, unlinked references, editing and collapse are untouched",
      refs.filterControl === true && refs.unlinked === true && refs.editors === 0 &&
      refs.rows.filter((r) => r.collapsedAttr && r.collapsedAttr !== 'false').length ===
        RG.COLLAPSED_APPEARANCES,
      `filter ${refs.filterControl}, unlinked ${refs.unlinked}, ${refs.editors} editor(s), ` +
      `${refs.rows.filter((r) => r.collapsedAttr && r.collapsedAttr !== 'false').length}` +
      `/${RG.COLLAPSED_APPEARANCES} collapsed`);
    record('P4.7', 'the child-context controls from the previous slice are still there',
      refs.ctxControls === RG.COLLAPSED_APPEARANCES,
      `${refs.ctxControls} control(s), expected ${RG.COLLAPSED_APPEARANCES}`);

    // ---------- P5 : one role, on every row ----------
    say('\nP5  every row says why it is here, once');
    const direct = refs.rows.filter((r) => r.role === 'direct');
    const context = refs.rows.filter((r) => r.role === 'context');
    const unlabelled = refs.rows.filter((r) => !r.role);
    observations.roles = {
      rows: refs.rows.length,
      direct: direct.length,
      context: context.length,
      unlabelled: unlabelled.length,
      directIds: [...new Set(direct.map((r) => r.id))],
      sample: refs.rows.slice(0, 8).map((r) => ({ role: r.role, text: r.text.slice(0, 40) })),
    };
    record('P5.1', 'every row carries exactly one role label, and none carries two',
      unlabelled.length === 0 && refs.rows.every((r) => r.labels === 1) &&
      refs.labelsInsideLabels === 0 && refs.labels === refs.rows.length,
      `${refs.labels} label(s) for ${refs.rows.length} row(s); ` +
      `${unlabelled.length} unlabelled, ` +
      `${refs.rows.filter((r) => r.labels > 1).length} doubled`);
    record('P5.2', 'the two roles account for every row and nothing else appears',
      direct.length + context.length === refs.rows.length &&
      refs.rows.every((r) => r.role === 'direct' || r.role === 'context'),
      `${direct.length} direct + ${context.length} context = ${refs.rows.length}`);

    // The claim that matters: the DIRECT rows are exactly the appearances of the
    // blocks OG itself counted, and no others.
    const directIds = new Set(direct.map((r) => r.id));
    const contextIds = new Set(context.map((r) => r.id));
    record('P5.3', 'the rows labelled a mention are exactly the blocks the heading counts',
      [...directIds].every((id) => DIRECT_IDS.has(id)) &&
      [...DIRECT_IDS].every((id) => directIds.has(id)) &&
      directIds.size === DIRECT.length,
      `${directIds.size} distinct block(s) labelled a mention, ${DIRECT.length} counted; ` +
      `missing ${JSON.stringify(DIRECT.filter((k) => !directIds.has(U[k])))}; ` +
      `extra ${JSON.stringify([...directIds].filter((id) => !DIRECT_IDS.has(id)))}`);
    record('P5.4', 'and no block that names the page is labelled context anywhere',
      [...contextIds].every((id) => !DIRECT_IDS.has(id)),
      `${contextIds.size} distinct context block(s); ` +
      `overlap ${JSON.stringify([...contextIds].filter((id) => DIRECT_IDS.has(id)))}`);
    // The visible label and OG's own invisible marker must agree. `data-refs-self`
    // holds the page names this block itself refs, which is the same fact.
    const disagree = refs.rows.filter((r) =>
      (r.role === 'direct') !== ((r.refsSelf || '').includes(RG.ANCHOR)));
    record('P5.5', 'the visible label agrees with OG\'s own invisible `data-refs-self`',
      disagree.length === 0,
      disagree.length ? JSON.stringify(disagree.slice(0, 4).map((r) =>
        ({ role: r.role, refsSelf: r.refsSelf, text: r.text.slice(0, 30) })))
        : `${refs.rows.length} row(s) agree`);
    record('P5.6', 'a context row is not merely an unlabelled one: it says what it is',
      context.length > 0 && context.every((r) => r.roleText && r.roleText.length > 0) &&
      direct.every((r) => r.roleText && r.roleText.length > 0) &&
      new Set(direct.map((r) => r.roleText)).size === 1 &&
      new Set(context.map((r) => r.roleText)).size === 1,
      `mention "${(direct[0] || {}).roleText}", context "${(context[0] || {}).roleText}"`);
    record('P5.7', 'each label carries the sentence that explains it',
      refs.rows.every((r) => r.roleTitle && r.roleTitle.length > 20) &&
      direct.every((r) => /mentions this page/i.test(r.roleTitle)) &&
      context.every((r) => /does not mention this page/i.test(r.roleTitle)),
      `mention: "${(direct[0] || {}).roleTitle}" | context: "${(context[0] || {}).roleTitle}"`);

    // ---------- P6 : a child that ALSO mentions the page ----------
    say('\nP6  a child that also mentions the page is never called context-only');
    const mixedRefRows = rowsOf(refs, 'mixedRef');
    observations.mixedRef = mixedRefRows;
    record('P6.1', 'the block is drawn twice in this one list, in two positions',
      mixedRefRows.length === RG.TWICE.occurrences &&
      new Set(mixedRefRows.map((r) => r.parent)).size === RG.TWICE.occurrences,
      `${mixedRefRows.length} appearance(s), parents ` +
      JSON.stringify(mixedRefRows.map((r) => r.parent)));
    record('P6.2', 'BOTH appearances are labelled a mention; neither is labelled context',
      mixedRefRows.length > 0 && mixedRefRows.every((r) => r.role === 'direct'),
      JSON.stringify(mixedRefRows.map((r) => ({ parent: r.parent, role: r.role,
                                                text: r.roleText }))));
    // The nested appearance says WHY it is here twice; the root one does not.
    const nested = mixedRefRows.filter((r) => r.parent !== null);
    const rootAppearance = mixedRefRows.filter((r) => r.parent === null);
    record('P6.3', 'the repeated appearance explains itself, and the counted one does not',
      nested.length > 0 && nested.every((r) => /shown here again/i.test(r.roleTitle || '')) &&
      rootAppearance.every((r) => !/shown here again/i.test(r.roleTitle || '')),
      `nested: "${(nested[0] || {}).roleTitle}" | own result: ` +
      `"${(rootAppearance[0] || {}).roleTitle}"`);
    // The children OF that block are context in BOTH of its appearances.
    const mrKids = refs.rows.filter((r) => mixedRefRows.some((m) => m.i === r.parent));
    record('P6.4', 'its own children are context under both of its appearances',
      mrKids.length === RG.CHILDREN.mixedRef.own * mixedRefRows.length &&
      mrKids.every((r) => r.role === 'context'),
      `${mrKids.length} child row(s): ` +
      JSON.stringify([...new Set(mrKids.map((r) => r.role))]));
    // A block drawn twice cannot be given two answers.
    const perBlock = new Map();
    for (const r of refs.rows) {
      if (!perBlock.has(r.id)) perBlock.set(r.id, new Set());
      perBlock.get(r.id).add(r.role);
    }
    const inconsistent = [...perBlock.entries()].filter(([, s]) => s.size > 1);
    record('P6.5', 'no block anywhere in the list is given two different roles',
      inconsistent.length === 0,
      inconsistent.length ? JSON.stringify(inconsistent.map(([id, s]) => [id, [...s]]))
        : `${perBlock.size} distinct block(s), ` +
          `${refs.rows.length - perBlock.size} of them drawn more than once`);

    // ---------- P7 : inert ----------
    say('\nP7  the labels are inert: nothing to press, nowhere to tab to');
    record('P7.1', 'every label is a plain span with no interactive part',
      refs.rows.every((r) => r.roleTag === 'SPAN' && r.roleTabIndex === null &&
                             r.roleHref === null && r.roleInteractive === 0),
      `tags ${JSON.stringify([...new Set(refs.rows.map((r) => r.roleTag))])}, ` +
      `tabindex ${JSON.stringify([...new Set(refs.rows.map((r) => r.roleTabIndex))])}, ` +
      `interactive descendants ` +
      `${refs.rows.reduce((n, r) => n + r.roleInteractive, 0)}`);
    record('P7.2', 'the labels add no keyboard stop to the section',
      refs.focusableRoles === 0,
      `${refs.focusable} focusable element(s) in the section, ` +
      `${refs.focusableRoles} of them inside a role label`);
    // Pressing where a label is must do nothing at all.
    phase('roles', 'click-a-label');
    const clicked = await page.evaluate(() => {
      const el = document.querySelector('.references.page-linked .f28-role');
      if (!el) return null;
      el.click();
      return { text: (el.innerText || '').trim() };
    }).catch(() => null);
    await sleep(1800);
    const afterClick = await read();
    record('P7.3', 'clicking a label opens nothing, edits nothing and navigates nowhere',
      !!clicked && afterClick.present && afterClick.editors === 0 &&
      afterClick.rows.length === refs.rows.length &&
      afterClick.heading === refs.heading,
      `clicked "${clicked && clicked.text}"; ${afterClick.editors} editor(s), ` +
      `${afterClick.rows.length} row(s), "${afterClick.heading}"`);

    // ---------- P8 : the same answer across redraws ----------
    say('\nP8  the same answer every time the section is redrawn');
    const baseline = assignment(refs);
    observations.redraws = [];
    const compare = async (id, title, why) => {
      const r = await read();
      const same = r.present && assignment(r) === baseline;
      observations.redraws.push({ why, rows: r.rows.length, same });
      record(id, title, same,
        same ? `${r.rows.length} row(s), the same ${r.labels} label(s) on the same rows`
             : `assignment changed after ${why}`);
      return r;
    };

    // (a) opening and closing the child-context panel from the previous slice.
    phase('roles', 'open-a-child-context-panel');
    await page.evaluate((uuid) => {
      const el = document.querySelector(
        `.references.page-linked .ls-block[blockid="${uuid}"]`);
      const btn = el ? el.querySelector(':scope > .f28-ctx > .f28-ctx-open') : null;
      if (btn) btn.click();
    }, U.jC1a).catch(() => null);
    await sleep(2500);
    const withPanel = await read();
    record('P8.1', 'a disclosed descendant inside that panel carries NO role label',
      (withPanel.rows.find((r) => r.id === U.jC1a) || {}).ctxPanelLabels === 0,
      `panel labels: ` +
      `${(withPanel.rows.find((r) => r.id === U.jC1a) || {}).ctxPanelLabels}; ` +
      `a panel row is plain text, and a role belongs to a real row`);
    await page.evaluate((uuid) => {
      const el = document.querySelector(
        `.references.page-linked .ls-block[blockid="${uuid}"]`);
      const btn = el ? el.querySelector(':scope > .f28-ctx > .f28-ctx-open') : null;
      if (btn) btn.click();
    }, U.jC1a).catch(() => null);
    await sleep(2200);
    await compare('P8.2', 'unchanged after a child-context panel opened and closed',
                  'the child-context panel');

    // (b) OG's own fold, which redraws the row and everything under it.
    phase('roles', 'fold-and-unfold-with-OGs-own-control');
    const foldOnce = async () => page.evaluate((uuid) => {
      const el = document.querySelector(
        `.references.page-linked .ls-block[blockid="${uuid}"]`);
      const c = el ? el.querySelector(':scope > .block-main-container .block-control') : null;
      if (!c) return false;
      c.click();
      return true;
    }, U.mixed).catch(() => false);
    const folded = await foldOnce();
    await sleep(2200);
    const duringFold = await read();
    record('P8.3', 'while a row is folded, the rows still drawn keep their own roles',
      folded && duringFold.present &&
      duringFold.rows.every((r) => r.role === 'direct' || r.role === 'context') &&
      duringFold.rows.filter((r) => r.role === 'direct')
        .every((r) => DIRECT_IDS.has(r.id)),
      `${duringFold.rows.length} row(s) drawn while folded, ` +
      `${duringFold.rows.filter((r) => r.role === 'direct').length} mention(s)`);
    await foldOnce();
    await sleep(2200);
    await compare('P8.4', 'and OG\'s fold put back leaves the section exactly as it was',
                  'OG\'s own fold control');

    // (c) the filter dialog — a real redraw, with nothing applied and nothing
    //     written. See the header for why no filter is applied.
    phase('roles', 'open-and-dismiss-the-filter-dialog');
    await page.locator('a.filter').first().click({ timeout: 15000 }).catch(() => null);
    await sleep(2500);
    const filterNames = await page.evaluate(() => {
      const m = document.querySelector('.ls-filters, .filters');
      return m ? [...m.querySelectorAll('button')].map((b) => (b.innerText || '').trim())
        .filter(Boolean) : null;
    }).catch(() => null);
    observations.filterOptions = filterNames;
    record('P8.5', 'the filter still opens and still offers the pages it offered',
      !!filterNames && filterNames.length > 0,
      JSON.stringify(filterNames));
    await page.keyboard.press('Escape').catch(() => null);
    await sleep(2000);
    await compare('P8.6', 'unchanged after the filter dialog opened and closed',
                  'the filter dialog');

    // (d) navigating away and back — the section is built again from scratch.
    phase('roles', 'navigate-away-and-back');
    await goTo(RG.CHILD_PAGE);
    await sleep(2500);
    await goTo(RG.ANCHOR);
    await settle('back on the anchor page');
    await compare('P8.7', 'unchanged after navigating away and back',
                  'navigation away and back');

    // ---------- P9 : Korean ----------
    say('\nP9  the same two roles, in Korean');
    phase('roles', 'switch-the-interface-to-korean');
    const setLanguage = (lang) => page.evaluate((l) => {
      const st = window.frontend && window.frontend.state;
      const fn = st && st.set_preferred_language_BANG_;
      if (typeof fn !== 'function') return { ok: false, reason: 'no language seam' };
      fn(l);
      return { ok: true };
    }, lang).catch((e) => ({ ok: false, reason: String(e.message) }));
    const switched = await setLanguage('ko');
    await sleep(3500);
    const ko = await read();
    observations.korean = ko.present ? {
      labels: ko.labels,
      direct: [...new Set(ko.rows.filter((r) => r.role === 'direct').map((r) => r.roleText))],
      context: [...new Set(ko.rows.filter((r) => r.role === 'context').map((r) => r.roleText))],
      title: (ko.rows.find((r) => r.role === 'context') || {}).roleTitle,
    } : ko;
    record('P9.1', 'the interface language really changed', switched.ok === true,
      switched.ok ? 'frontend.state/set-preferred-language! → ko'
                  : `not switched: ${switched.reason}`);
    record('P9.2', 'every label is Korean, and neither role kept its English word',
      ko.present && ko.labels === ko.rows.length &&
      ko.rows.every((r) => /[가-힣]/.test(r.roleText || '')) &&
      ko.rows.every((r) => !/mention|context/i.test(r.roleText || '')),
      ko.present ? `${ko.labels} label(s): ` +
        JSON.stringify([...new Set(ko.rows.map((r) => r.roleText))]) : 'no section');
    record('P9.3', 'the sentences are Korean too, and are not split mid-character',
      ko.present && ko.rows.every((r) => /[가-힣]/.test(r.roleTitle || '')) &&
      !ko.rows.some((r) => /[�]/.test(r.roleTitle || '')),
      ko.present ? `"${(ko.rows.find((r) => r.role === 'context') || {}).roleTitle}"` : '—');
    record('P9.4', 'and the ROLES are identical to the English reading',
      ko.present && assignment(ko) === baseline,
      ko.present ? (assignment(ko) === baseline
        ? 'the same role on the same row, in both languages'
        : 'the assignment changed with the language') : '—');
    record('P9.5', 'Korean and emoji in the graph\'s own text still read correctly',
      ko.present && /[가-힣]/.test(ko.sectionText) &&
      /🍃|🌱|🧩|🅰️|🅱️|📚|🪜|📦/.test(ko.sectionText) &&
      !/�/.test(ko.sectionText),
      `hangul ${/[가-힣]/.test(ko.sectionText || '')}, ` +
      `emoji ${/🍃|🌱|🧩|🅰️|🅱️|📚|🪜|📦/.test(ko.sectionText || '')}`);
    // The label subscribes to the language, so it must follow it WITHOUT the row
    // being redrawn for some other reason. Measured rather than assumed: the
    // first run of this scenario found 47 labels still reading "mention" after
    // the switch, because the label was not reactive and `frontend.util/react`
    // degrades to a plain deref outside a reactive component.
    record('P9.6', 'the labels followed the language with no navigation and no redraw',
      ko.present && ko.rows.length === refs.rows.length &&
      ko.rows.every((r) => /[가-힣]/.test(r.roleText || '')),
      ko.present ? `${ko.rows.length} row(s) still drawn, ` +
        `${ko.rows.filter((r) => /[가-힣]/.test(r.roleText || '')).length} of them relabelled ` +
        `in place` : '—');
    await setLanguage('en');
    await sleep(3000);
    await compare('P9.7', 'and switching back to English restores exactly what was there',
                  'the language switch');

    // ---------- P10 : the right sidebar ----------
    say('\nP10 the right sidebar, a named exclusion, measured live');
    // The ANCHOR page, by name, from a page that links to it — the same route
    // the child-context run uses. The first version of this step shift-clicked
    // the first page link it found inside the section, which opened a page with
    // no linked references of its own and measured nothing.
    phase('roles', 'open-the-anchor-in-the-right-sidebar');
    await goTo(RG.DEEP_PAGE);
    await sleep(2500);
    await parkPointer();
    let opened = { found: false };
    try {
      await page.locator(`#main-content-container a.page-ref:text-is("${RG.ANCHOR}")`)
        .first().click({ modifiers: ['Shift'], timeout: 20000 });
      opened = { found: true };
    } catch (e) {
      opened = { found: false, error: String(e.message).split('\n')[0] };
    }
    await sleep(6000);
    for (let i = 0; i < 8; i++) {
      await page.evaluate(() => {
        for (const sel of ['#right-sidebar .sidebar-item-list', '#right-sidebar',
                           '.sidebar-item-list']) {
          const sb = document.querySelector(sel);
          if (sb) sb.scrollTop = sb.scrollHeight;
        }
      }).catch(() => null);
      await sleep(1300);
    }
    const sidebar = await page.evaluate(() => ({
      present: !!document.querySelector('#right-sidebar'),
      items: document.querySelectorAll('.sidebar-item').length,
      refs: document.querySelectorAll('.sidebar-item .references.page-linked').length,
      rows: document.querySelectorAll(
        '.sidebar-item .references.page-linked .ls-block[blockid]').length,
      labels: document.querySelectorAll('.sidebar-item .f28-role').length,
      mainLabels: document.querySelectorAll(
        '#main-content-container .references.page-linked .f28-role').length,
    })).catch(() => null);
    observations.sidebar = sidebar;
    record('P10.1', "a linked-references list really is rendered in the right sidebar",
      !!sidebar && sidebar.items > 0 && sidebar.rows > 0,
      JSON.stringify(sidebar) + ` (shift-click found a link: ${opened.found})`);
    record('P10.2', 'and it carries NO role label at all',
      !!sidebar && sidebar.rows > 0 && sidebar.labels === 0,
      sidebar ? `${sidebar.rows} sidebar row(s), ${sidebar.labels} label(s); ` +
                `${sidebar.mainLabels} label(s) in the main area's own list at the ` +
                `same moment` : 'no reading');

    // ---------- P11 : the graph, from the application's side ----------
    say('\nP11 the graph, before the application is closed');
    const controlNow = RG.readPage(GRAPH, RG.CONTROL_FILE);
    record('P11.1', 'the control page is byte-identical while the application is still open',
      controlNow === controlBefore, `${controlNow.length} bytes`);
  } finally {
    errorEvidence = await session.collectErrorEvidence();
    await APP.close(session, { say });
  }

  // ---------- after the application has closed ----------
  say('\nP12 the graph, after the application has closed');
  const after = GH.snapshot(GRAPH);
  const cmp = GH.compare(before, after);
  record('P12.1', 'no content file changed: this feature only reads the graph',
    cmp.content.length === 0,
    cmp.content.length ? JSON.stringify(cmp.content.map((c) => `${c.change} ${c.file}`))
                       : `0 content changes across ${cmp.afterCount} files`);
  record('P12.2', 'OG housekeeping is recorded separately rather than counted as content', true,
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
  const featurePhases = ['roles'];
  const inFeature = split.remaining.filter((e) => featurePhases.includes(e.phase));
  record('P12.3', 'no window error arrived in any phase that operated this feature',
    inFeature.length === 0,
    `${inFeature.length} in ${JSON.stringify(featurePhases)}; ` +
    `${split.remaining.length} unexplained in total` +
    (split.remaining.length ? ` (${split.remaining.map((e) => e.phase).join(', ')})` : ''));
  record('P12.4', 'every window error was entitled; ONLY the exact browser notice is ever exempted',
    split.remaining.length === 0,
    `${errors.entries().length} captured across ${JSON.stringify(cls.byPhase)}; ` +
    `${cls.expected.length} expected, ${split.noise.length} exempted, ` +
    `${split.refused.length} handler line(s) refused by the rule, ` +
    `${split.remaining.length} unexplained` +
    (split.remaining.length ? `: ${EC.describe(split.remaining, 1)[0]}` : ''));

  const leftovers = ownedTree.filter(OP.alive);
  record('P12.5', 'every process this run owned has exited', leftovers.length === 0,
    leftovers.length ? JSON.stringify(leftovers)
                     : `${ownedTree.length} process(es) owned at launch, none still alive`);

  const pass = results.filter((r) => r.ok).length;
  const out = path.join(EVIDENCE, `f28-refrole-feature-${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify({ results, observations, graph: GRAPH }, null, 2));
  fs.writeFileSync(path.join(EVIDENCE, 'f28-refrole-feature-summary.json'),
    JSON.stringify({ results: results.map((r) => ({ id: r.id, ok: r.ok, title: r.title })),
                     build: observations.build, graph: GRAPH,
                     passed: pass, total: results.length }, null, 2));
  say(`\n  ${pass}/${results.length} checks passed`);
  say(`  evidence: ${out}\n`);
  if (pass !== results.length) process.exitCode = 1;
}

main().catch((e) => { say(`\nFAILED: ${e.stack || e.message}\n`); process.exitCode = 1; });
