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
// THE FILTER, APPLIED — AND ITS WRITE, KEPT SEPARATE. The first run of this
// scenario only opened and dismissed the filter dialog, which redraws the
// section but proves nothing about roles UNDER a filter. This run applies both
// semantics, exclude first and then include, on THIS RUN'S OWN fresh synthetic
// graph (P1.1) — the only data any part of it may touch. Applying a filter
// makes OG's own `page-handler/save-filter!` persist the choice as a
// `filters::` property in the anchor page's FILE. That is OG's normal filter
// behaviour acting at this run's explicit request, NOT a write by the labels,
// which read only. It is therefore recorded in full (P12.6, P12.7) and kept out
// of the labels' read-only claim (P12.1): the feature's own proof remains that
// nothing else changed anywhere in the graph.
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

  // The filter phase (P13) runs inside the try below; its write is accounted
  // for after the application has closed (P12.6, P12.7), so what it chose and
  // the page file it is about travel out here.
  const filterAccounting = {
    anchorFile: `pages/${RG.ANCHOR}.md`,
    anchorBefore: null,
    page: null,
    directCount: null,
  };

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
    // holds the page names this block itself refs — and `build-refs-data-value`
    // reads them through `get-page-names-by-ids`, which pulls `:block/name`: the
    // identity OG's own mandate (`page-name-sanity-lc`, lower-cased and sanitized)
    // stores a page under, NOT the display case the fixture names it in. The
    // first packaged run compared against the display-case name and disagreed
    // with all 11 mention rows on case alone. The identity is therefore read
    // LIVE from the application and cross-checked rather than case-folded here:
    // OG's own API must return a real page whose original name is the fixture's,
    // and OG's own mandate function applied to that display name must be the
    // name that page is stored under. If the two do not agree, the check fails
    // rather than guessing a case.
    const readPageIdentity = (display) => page.evaluate((name) => {
      const out = { apiPage: null, apiError: null, canonical: null, mandateError: null };
      try {
        const api = window.logseq && window.logseq.api;
        const p = api && typeof api.get_page === 'function' ? api.get_page(name) : null;
        out.apiPage = p ? { name: p.name || null, originalName: p.originalName || null }
                       : null;
      } catch (e) { out.apiError = String(e && e.message); }
      try {
        // The same mandate function `db.model/get-page` looks a page up with,
        // live in the packaged renderer: `frontend.util/safe-page-name-sanity-lc`.
        const f = window.frontend && window.frontend.util &&
                  window.frontend.util.safe_page_name_sanity_lc;
        out.canonical = typeof f === 'function' ? f(name) : null;
      } catch (e) { out.mandateError = String(e && e.message); }
      return out;
    }, display).catch((e) => ({ apiPage: null, apiError: String(e && e.message),
                                canonical: null, mandateError: null }));
    const anchorIdentity = await readPageIdentity(RG.ANCHOR);
    observations.anchorIdentity = anchorIdentity;
    const canonical = anchorIdentity.canonical;
    const identityHolds = canonical !== null && anchorIdentity.apiPage !== null &&
      anchorIdentity.apiPage.name === canonical &&
      anchorIdentity.apiPage.originalName === RG.ANCHOR;
    const disagree = identityHolds ? refs.rows.filter((r) =>
      (r.role === 'direct') !== ((r.refsSelf || '').includes(canonical))) : [];
    record('P5.5', 'the visible label agrees with OG\'s own invisible `data-refs-self`',
      identityHolds && disagree.length === 0,
      () => identityHolds
        ? (disagree.length
            ? JSON.stringify(disagree.slice(0, 4).map((r) =>
                ({ role: r.role, refsSelf: r.refsSelf, text: r.text.slice(0, 30) })))
            : `${refs.rows.length} row(s) agree, against the page's canonical name ` +
              `"${canonical}", read live from the application`)
        : `the page's identity could not be established live: ` +
          JSON.stringify(anchorIdentity));
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
    // The regression for the case the first packaged run failed on, and for the
    // page that must NOT match:
    //   * the NORMALIZATION case is genuinely exercised — the fixture names the
    //     anchor page in display case, so the canonical name really differs
    //     from the display name, and every mention row's `data-refs-self`
    //     carries the canonical form. If the fixture is ever renamed so the
    //     two stop differing, this comparison stops proving anything and the
    //     check says so instead of passing quietly;
    //   * a GENUINELY DIFFERENT page — the fixture's filter page, which one
    //     context row names — must not turn its row into a mention of THIS
    //     page. That row is context, its `data-refs-self` names the filter
    //     page, and the filter page is a real, distinct page in its own right,
    //     verified by the same live identity read.
    const filterIdentity = await readPageIdentity(RG.FILTER_TAG);
    observations.filterPageIdentity = filterIdentity;
    const filterCanonical = filterIdentity.canonical;
    const filterRows = identityHolds && filterCanonical !== null &&
                       filterCanonical !== canonical
      ? refs.rows.filter((r) => (r.refsSelf || '').includes(filterCanonical)) : [];
    record('P5.8', 'the identity the comparison used is the page\'s real one, and a genuinely ' +
      'different page does not match it',
      identityHolds && canonical !== RG.ANCHOR && filterCanonical !== null &&
      filterCanonical !== canonical &&
      filterIdentity.apiPage !== null && filterIdentity.apiPage.name === filterCanonical &&
      filterIdentity.apiPage.originalName === RG.FILTER_TAG &&
      filterRows.length >= 1 &&
      filterRows.every((r) => r.role === 'context') &&
      filterRows.every((r) => !(r.refsSelf || '').includes(canonical)),
      () => `canonical "${canonical}" ≠ display "${RG.ANCHOR}"; ` +
        `the different page "${filterCanonical}" is real and distinct, named by ` +
        `${filterRows.length} row(s), all labelled context`);

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

    // (c) the filter dialog — a real redraw, with nothing applied yet and
    //     nothing written. The filter APPLIED, and its write, are P13 and
    //     P12.6/P12.7; this redraw happens while the page still has no filter.
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

    // ---------- P13 : the filter, APPLIED ----------
    // Roles under a filter that really removes rows. The graph this run works
    // on is its own fresh synthetic one, so OG's own `save-filter!` write lands
    // only on data this run generated. Both semantics are exercised — exclude
    // first, then include — and every still-drawn row must carry the same role
    // it carried unfiltered, because the role is the BLOCK's and the filter
    // only changes WHICH rows are drawn. See the header for how the write is
    // kept separate from the labels' read-only claim.
    //
    // What the two earlier runs of this phase taught, and what this phase
    // therefore does differently:
    //
    //   * The click is a REAL one with the keyboard modifier held, because
    //     OG's own handler reads the event's shiftKey. Run 3 dispatched a
    //     synthetic event through `page.evaluate` with TWO arguments —
    //     Playwright's evaluate takes exactly one — so nothing was ever
    //     clicked, and "NOT clicked" looked exactly like "filter did not
    //     apply". A real click cannot be mis-issued that way.
    //
    //   * The reading SETTLES, like every other reading in this scenario.
    //     OG renders each source page's item of this list behind a
    //     viewport observer (`ui/lazy-visible`), and applying a filter
    //     remounts those items as placeholders until they are scrolled
    //     past. Run 4 read 2.5s after the click without scrolling, and
    //     measured whichever items happened to be in view: a heading of
    //     "4 of 10" with only 23 of the 26 rows the filter kept. The
    //     heading counts the kept mentions correctly — it is `filter-n`,
    //     derived from `:block/path-refs`, and both runs agreed with the
    //     fixture's arithmetic — but a reading that has not settled says
    //     nothing about what is drawn.
    //
    //   * What is ASSERTED is what the labels own: every drawn row keeps its
    //     unfiltered role, and the heading counts the filtered set the
    //     fixture says it must (10 mentions minus the 6 living on the
    //     excluded page; 6 under the include). OG's own choice of WHICH
    //     kept rows to draw is recorded in the evidence — every drawn row,
    //     and the item/group structure — but not asserted, because it is
    //     OG's drawing and not this feature's claim.
    say('\nP13 the filter APPLIED: roles under a filter that really removes rows');
    filterAccounting.anchorBefore = RG.readPage(GRAPH, filterAccounting.anchorFile);
    // The right sidebar is still open from P10 and carries its own unlabelled
    // copy of this list; close it with OG's own control so every reading below
    // is of the main area's list, then return to the anchor page.
    await page.evaluate(() => {
      const st = window.frontend && window.frontend.state;
      if (st && typeof st.hide_right_sidebar_BANG_ === 'function') st.hide_right_sidebar_BANG_();
    }).catch(() => null);
    await goTo(RG.ANCHOR);
    await settle('back on the anchor page');
    // The source page to filter on, read out of the unfiltered section rather
    // than assumed: the group with the most direct mentions.
    const groupDirect = refs.items.map((item) => ({
      page: item.page,
      rows: new Set(item.groups.flatMap((gp) => gp.ids)),
      direct: [...new Set(item.groups.flatMap((gp) => gp.ids)
        .filter((id) => DIRECT_IDS.has(id)))],
    }));
    const chosen = groupDirect.reduce((a, b) => (b.direct.length > a.direct.length ? b : a));
    const chosenIds = new Set(chosen.rows);
    const chosenDirectIds = new Set(chosen.direct);
    const chosenDirectCount = chosen.direct.length;
    filterAccounting.page = chosen.page;
    filterAccounting.directCount = chosenDirectCount;

    // Every step of the filter interaction is recorded, because the first
    // attempt of this phase taught exactly that lesson: a swallowed click is
    // indistinguishable from a filter that did not apply. `openFilter` records
    // whether the section's own filter control was there to be clicked and
    // whether OG's modal opened; `clickFilterButton` records which button the
    // dialog offered, whether the click reached it, and — the only thing that
    // counts — whether the section actually changed.
    const filterDiagnostics = [];
    const dialogState = () => page.evaluate(() => {
      const m = document.querySelector('.ls-filters, .filters');
      if (!m) return { open: false };
      const buttons = [...m.querySelectorAll('button')]
        .map((b) => (b.innerText || '').trim()).filter(Boolean);
      return { open: true, buttons: buttons.slice(0, 12) };
    }).catch((e) => ({ open: false, error: String(e && e.message) }));
    const headingNow = () => page.evaluate(() => {
      const sec = document.querySelector('#main-content-container .references.page-linked');
      const h = sec && sec.querySelector('h2');
      return h ? (h.innerText || '').trim() : null;
    }).catch(() => null);
    const openFilter = async () => {
      const diag = { step: 'open', aFilter: await page.locator('a.filter').count()
        .catch(() => -1), clickError: null, dialog: null };
      try {
        await page.locator('a.filter').first().click({ timeout: 15000 });
      } catch (e) {
        diag.clickError = String(e && e.message).split('\n')[0].slice(0, 220);
      }
      await sleep(2500);
      diag.dialog = await dialogState();
      filterDiagnostics.push(diag);
      return diag;
    };
    // OG's own on-click handler decides include from exclude by reading the
    // event's shiftKey, so the click is a real one with the keyboard modifier
    // held — the interaction a user actually has. Run 3 of this phase
    // dispatched a synthetic event instead, and its `page.evaluate` call
    // passed two arguments where Playwright accepts exactly one, so the
    // click never happened at all; a swallowed click is indistinguishable
    // from a filter that did not apply. The click is only trusted once its
    // EFFECT is visible in the section: the heading must change.
    const clickFilterButton = async (pageName, exclude, headingBefore) => {
      const diag = { step: exclude ? 'exclude' : 'toggle', clicked: false,
                     applied: false, method: null, clickError: null,
                     headingAfter: null, dialog: null };
      try {
        await page.locator('.ls-filters button', { hasText: pageName }).first()
          .click({ timeout: 8000, modifiers: exclude ? ['Shift'] : [] });
        diag.clicked = true;
      } catch (e) {
        diag.clickError = String(e && e.message).split('\n')[0].slice(0, 220);
      }
      let after = null;
      for (let i = 0; i < 5 && !diag.applied; i++) {
        await sleep(1200);
        after = await headingNow();
        diag.applied = after !== null && after !== headingBefore;
      }
      if (diag.applied) { diag.method = 'real-click'; diag.headingAfter = after; }
      diag.dialog = await dialogState();
      filterDiagnostics.push(diag);
      return diag;
    };
    // A comparable role assignment over whichever rows are drawn now.
    const rolesOf = (r) => new Map(r.rows.map((x) => [x.id, x.role]));
    const unfilteredRoles = rolesOf(refs);
    const everyDrawnRowAgrees = (r) => r.rows.every((x) =>
      unfilteredRoles.get(x.id) === x.role);

    // (a) EXCLUDE the chosen page: its mentions leave the list.
    phase('filtering', 'apply-an-exclude-filter');
    await openFilter();
    const excludeClicked = await clickFilterButton(chosen.page, true, refs.heading);
    await page.keyboard.press('Escape').catch(() => null);
    // Settle — scroll the section into being — before reading, for the same
    // reason every other reading settles: OG renders this list's page-items
    // only once the viewport has reached them.
    await settle('under the exclude filter');
    const excl = await read();
    observations.filterExclude = excl.present ? {
      heading: excl.heading,
      rows: excl.rows.length,
      labels: excl.labels,
      rowIds: [...new Set(excl.rows.map((x) => x.id))],
      rowsDrawn: excl.rows.map((x) => ({ id: x.id, parent: x.parent, role: x.role })),
      items: excl.items,
      removedDirectIds: [...chosenDirectIds].filter((id) =>
        !excl.rows.some((x) => x.id === id)),
    } : excl;
    record('P13.1', 'excluding a source page really removes its rows from the list',
      excludeClicked.applied && excl.present &&
      chosenDirectIds.size > 0 &&
      [...chosenDirectIds].every((id) => !excl.rows.some((x) => x.id === id)) &&
      [...new Set(excl.rows.map((x) => x.id))].every((id) => !chosenIds.has(id)),
      () => `${excludeClicked.applied ? 'applied' : 'did NOT apply'} the exclude of ` +
        `"${chosen.page}" (${excludeClicked.method || 'no method reached OG'}); ` +
        `${chosenDirectIds.size} mention(s) and ${chosenIds.size} row(s) of that page ` +
        `gone, ${excl.rows.length} row(s) drawn`);
    // The heading is `filter-n`, counted by OG over `:block/path-refs` — the
    // same identity the labels read. The fixture says what it must be: every
    // mention of the anchor EXCEPT the ones living on the excluded page.
    record('P13.2', 'and the heading now counts the filtered set, not the whole list',
      excl.present &&
      excl.heading === `${DIRECT.length - chosenDirectCount} of ${DIRECT.length} Linked References`,
      () => `"${excl.heading}" (was "${refs.heading}"); ${DIRECT.length} mention(s) ` +
        `minus the ${chosenDirectCount} that live on "${chosen.page}"`);
    record('P13.3', 'every row still drawn keeps the role it had unfiltered',
      excl.present && excl.rows.length > 0 &&
      excl.rows.every((x) => x.labels === 1) &&
      excl.rows.every((x) => x.role === 'direct' || x.role === 'context') &&
      everyDrawnRowAgrees(excl),
      () => `${excl.rows.length} row(s) drawn under the exclude, ` +
        `${excl.rows.filter((x) => !unfilteredRoles.get(x.id) || unfilteredRoles.get(x.id) !== x.role).length} ` +
        `of them reassigned`);

    // (b) INCLUDE the chosen page: only its rows remain. The exclude is
    // removed first (OG's own toggle: the second click dissocs), then the same
    // button is clicked without shift to include.
    phase('filtering', 'remove-the-exclude-then-apply-an-include-filter');
    await openFilter();
    const headingBeforeRemove = await headingNow();
    const removeClicked = await clickFilterButton(chosen.page, false, headingBeforeRemove);
    const headingBeforeInclude = await headingNow();
    const includeClicked = await clickFilterButton(chosen.page, false, headingBeforeInclude);
    await page.keyboard.press('Escape').catch(() => null);
    await settle('under the include filter');
    const incl = await read();
    observations.filterInclude = incl.present ? {
      heading: incl.heading,
      rows: incl.rows.length,
      labels: incl.labels,
      rowIds: [...new Set(incl.rows.map((x) => x.id))],
      rowsDrawn: incl.rows.map((x) => ({ id: x.id, parent: x.parent, role: x.role })),
      items: incl.items,
      directDrawn: [...new Set(incl.rows.filter((x) => x.role === 'direct').map((x) => x.id))],
    } : incl;
    // What is asserted here is the FEATURE's claim under an include: every
    // row still drawn belongs to the included page, every row still drawn
    // that is a mention is one of THAT page's mentions, at least one of its
    // mentions is drawn, and the heading counts exactly its mentions. Which
    // of the kept rows OG chooses to draw is recorded above — it is OG's
    // drawing, measured in the earlier runs to be a subset, and not this
    // feature's to promise.
    record('P13.4', 'including one source page keeps only that page\'s rows',
      removeClicked.applied && includeClicked.applied && incl.present &&
      incl.rows.length > 0 &&
      [...new Set(incl.rows.map((x) => x.id))].every((id) => chosenIds.has(id)) &&
      incl.rows.filter((x) => x.role === 'direct')
        .every((x) => chosenDirectIds.has(x.id)) &&
      [...chosenDirectIds].some((id) => incl.rows.some((x) => x.id === id)) &&
      incl.heading === `${chosenDirectCount} of ${DIRECT.length} Linked References`,
      () => `${removeClicked.applied ? 'removed the exclude' : 'did NOT remove the exclude'} ` +
        `(${removeClicked.method || 'no method'}), ` +
        `${includeClicked.applied ? 'applied the include' : 'did NOT apply the include'} ` +
        `(${includeClicked.method || 'no method'}); ` +
        `${incl.rows.length} row(s) drawn, all from "${chosen.page}", ` +
        `${new Set(incl.rows.filter((x) => x.role === 'direct').map((x) => x.id)).size} ` +
        `of its ${chosenDirectCount} mention(s) drawn, heading "${incl.heading}"`);
    record('P13.5', 'under the include too, the heading counts the filtered set and no row is reassigned',
      incl.present &&
      incl.heading === `${chosenDirectCount} of ${DIRECT.length} Linked References` &&
      incl.rows.every((x) => x.labels === 1) &&
      incl.rows.every((x) => x.role === 'direct' || x.role === 'context') &&
      everyDrawnRowAgrees(incl),
      () => `"${incl.heading}", ${incl.rows.length} row(s) drawn, ` +
        `${new Set(incl.rows.filter((x) => x.role === 'direct').map((x) => x.id)).size} ` +
        `distinct mention(s) of the page, ` +
        `${incl.rows.filter((x) => !unfilteredRoles.get(x.id) || unfilteredRoles.get(x.id) !== x.role).length} reassigned`);
    // What the application says it persisted, live — read through OG's own
    // page API, recorded as an observation; the FILE is checked after close.
    const liveState = await page.evaluate((display) => {
      const out = { filters: null, error: null };
      try {
        const api = window.logseq && window.logseq.api;
        const p = api && typeof api.get_page === 'function' ? api.get_page(display) : null;
        out.filters = p && p.properties ? p.properties.filters : null;
      } catch (e) { out.error = String(e && e.message); }
      return out;
    }, RG.ANCHOR).catch((e) => ({ filters: null, error: String(e && e.message) }));
    observations.filterLiveState = liveState;
    observations.filterClicks = filterDiagnostics;
    record('P13.6', 'the application reports the include as the page\'s own filter property',
      liveState.filters !== null && liveState.filters !== undefined &&
      JSON.stringify(liveState.filters).includes(chosen.page.toLowerCase()),
      () => `get_page(...).properties.filters = ${JSON.stringify(liveState.filters)}` +
        (liveState.error ? ` (error: ${liveState.error})` : ''));
  } finally {
    errorEvidence = await session.collectErrorEvidence();
    await APP.close(session, { say });
  }

  // ---------- after the application has closed ----------
  say('\nP12 the graph, after the application has closed');
  const after = GH.snapshot(GRAPH);
  const cmp = GH.compare(before, after);
  // The one write this run asked OG for: the filter property in the anchor
  // page's own file (P13). Everything else must be unchanged — that, and not
  // the absence of the recorded write, is the labels' read-only claim.
  const filterWrite = cmp.content.filter((c) =>
    c.file === filterAccounting.anchorFile && c.change === 'modified');
  const otherContent = cmp.content.filter((c) => !filterWrite.includes(c));
  record('P12.1', 'nothing changed except the one filter write this run asked OG for; the labels only read',
    otherContent.length === 0 && filterWrite.length === 1,
    otherContent.length
      ? JSON.stringify(otherContent.map((c) => `${c.change} ${c.file}`))
      : `${filterWrite.length} filter write(s) to ${filterAccounting.anchorFile} ` +
        `(recorded under P12.6 and P12.7); 0 other content changes across ` +
        `${cmp.afterCount} files`);
  record('P12.2', 'OG housekeeping is recorded separately rather than counted as content', true,
    cmp.housekeeping.length
      ? `${cmp.housekeeping.length}: ` +
        cmp.housekeeping.map((c) => `${c.change} ${c.file}`).slice(0, 6).join('; ')
      : 'none');

  // ---------- the filter's write, recorded in full ----------
  say('\nP12 the filter\'s own write, recorded in full and kept separate');
  const anchorAfter = RG.readPage(GRAPH, filterAccounting.anchorFile);
  const beforeLines = (filterAccounting.anchorBefore || '').split('\n');
  const afterLines = anchorAfter.split('\n');
  const added = afterLines.filter((l) => !beforeLines.includes(l));
  const gone = beforeLines.filter((l) => !afterLines.includes(l));
  const filterLine = added.find((l) => l.includes('filters::')) || null;
  record('P12.6', 'the filter write is exactly `filters::` property line(s) in the anchor page, and ' +
    'nothing the page said before was lost',
    filterWrite.length === 1 && added.length >= 1 &&
    added.every((l) => l.includes('filters::')) &&
    gone.every((l) => afterLines.some((a) => a.trim() === l.trim())),
    () => `added ${JSON.stringify(added)}, removed ${JSON.stringify(gone)}`);
  record('P12.7', 'and the property names the included page with a true value, as OG wrote it',
    !!filterLine && filterLine.includes(filterAccounting.page.toLowerCase()) &&
    /true/.test(filterLine),
    () => `filters line: ${JSON.stringify(filterLine)}` +
      (filterLine ? '' : ` (page "${filterAccounting.page}", ` +
        `${filterAccounting.directCount} mention(s))`));

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
  // The filtering phases operate this feature's surface too — a window error
  // while applying a filter is as much a finding as one while folding.
  const featurePhases = ['roles', 'filtering'];
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
