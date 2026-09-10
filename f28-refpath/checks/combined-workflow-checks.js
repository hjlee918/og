#!/usr/bin/env node
'use strict';
//
// THE COMBINED F27/F28 REFERENCE-WORKFLOW CHECKPOINT — in the packaged app.
//
//   node f28-refpath/checks/combined-workflow-checks.js
//
// One bounded integration batch on the current Intel test build, on the
// instruction of `F28_REFERENCE_ORDER_SUPERVISOR_ACCEPTANCE.md`: pause feature
// expansion, exercise the EXISTING F27 and F28 slices together as one reader
// would use them, fix concrete integration regressions within the existing
// scope, and produce a concise MVP-A coverage/gap summary. It is NOT the full
// OG baseline (never rerun here), not a new feature, and not a re-measurement of
// any slice's own accepted scenario.
//
// FIVE CONNECTED JOURNEYS, each answering a question no single-slice scenario
// can — "do these features still work when a reader uses them together?" — and
// each reusing the check vocabulary its own accepted run established:
//
//   C5  the BADGE journey: a compact incoming-reference overview opened from
//       the badge OG renders on the REFERENCED block's own page (the accepted
//       F27 walkthrough's model — an inline embed hides the badge at its own
//       top level, so the anchor page's badge row shows the target rendered
//       inline but carries no badge of its own); the Crystal marker chosen
//       from the graph's own tags, previewed and cleared; one row's ancestors
//       and children disclosed; the inbound explorer walked into a CYCLE and
//       stopped at the boundary, and taken Back; a genuine empty answer; source
//       navigation away — a real page change, landing back on the anchor page
//       whose list the return then reads.        (F27 overview + context)
//
//   C6  the DISCLOSURE journey: OG's own list with the F28 source-path panel
//       (the apple chain, elided by OG's breadcrumb) and the F28 child-context
//       panel (the zebra grandchild behind OG's level wall) BOTH OPEN, then the
//       source-page groups REORDERED under them — and the disclosures must
//       survive the reorder, still address their own block, and still OPERATE
//       on it afterwards: not merely that the ids match.       (F28 together)
//
//   C7  the INTERFACE journey: Korean and English across all four slices at
//       once, and the keyboard reaching the ordering control and a disclosure
//       control with no mouse at all.                    (language + keyboard)
//
//   C9  the REFRESH journey: the F27 inline panel open BESIDE the F28
//       linked-references list on the same page; the outgoing section listing
//       what the target itself points at; a declared synthetic edit through
//       OG's own API adding a source and Refresh showing it in place; the edit
//       undone and Refresh showing it gone — with the graph hashed around each
//       refresh so "Refresh writes nothing" is a measurement.   (F27 inline)
//
//   C10 the SCOPE journey: a real exclude filter applied by OG's own gesture,
//       the kept groups sorted, another page's list visited (fresh, unfiltered
//       by the choice left behind) and the anchor returned to — filter
//       persisted because it is a page property, ordering reset because it is
//       a view-local choice.                             (F28 + OG, documented)
//
//   C11 the EXCLUDED surface: the right sidebar's copy of the list carries
//       none of it — no ordering, no disclosure, no role labels, no inline
//       panels — measured live.
//
// READ-ONLY INTERVALS AND DECLARED WRITES, KEPT APART. Everything up to and
// including C8 is read-only and proved so by a hash taken while the
// application is still open, BEFORE the first declared write (C8). The
// declared writes are exactly two CONTENT FILES, changed by THREE mutation
// operations — every one made by OG at this run's explicit request and
// declared in advance in `make-combined-graph.js`:
//
//   * `logseq.api.update_block` on the joining source, TWICE — add, then
//     remove the reference — two operations on one file, both through OG's
//     own editor handler and outliner;
//   * a real exclude-filter click — OG's own `page-handler/save-filter!`
//     persists a `filters::` property in the anchor page's file.
//
// The graph is hashed again around every refresh press, so the refresh's own
// read-only claim stands on its own rather than on subtracting known writes
// from a total.
//
// THE UNRESOLVED `[frontend.handler]` CONDITION STANDS. The rule in
// `checks/browser-noise.js` refuses a handler line this harness cannot pair
// with Chromium's ResizeObserver notice. If it appears, the check it fails is
// reported as failed. It is not exempted, not widened, and the scenario is not
// rerun to make the number go up.
//
// MANDATORY GRAPH-DATA BOUNDARY (project-notes/DATA_ACCESS_GUARDRAIL.md).
// Graph data is only ever this run's own fresh synthetic graph inside
// ~/Library/Mobile Documents/com~apple~CloudDocs/Logseq Test. No personal graph
// is opened, read or enumerated, no earlier run's folder is touched, and the
// installed application is never launched. The loaded graph path is asserted —
// LIVE, from two sources OG itself holds — BEFORE any feature interaction.
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

const EVIDENCE = path.join(FEATURE_DIR, 'evidence');
const FEATURE_APP = 'Logseq-OG-F28-RefPath';

const results = [];
let ownedTree = [];
const errors = REC.createRecorder();
// Every INTENTIONAL change this run makes to the graph, with the call that
// made it. Kept apart from the read-only assertions on purpose: a scenario
// that mixes the two cannot say which of its observations were caused by
// itself.
const applied = [];
const observations = {};
let errorEvidence = null;
const sleep = OP.sleep;

function say(l) { try { fs.writeSync(1, l + '\n'); } catch (e) { console.log(l); } }
function record(id, title, ok, detail) {
  let text;
  try { text = String(typeof detail === 'function' ? detail() : detail); }
  catch (e) { text = `(could not describe this result: ${e.message})`; }
  results.push({ id, title, ok: !!ok, detail: text });
  say(`  ${ok ? 'PASS' : 'FAIL'}  ${id.padEnd(6)} ${title}\n          ${text}`);
  return ok;
}
function phase(name, operation) {
  errors.phase(name, operation);
  say(`  ┈ phase: ${name}${operation ? ` (${operation})` : ''}`);
}
const J = (v) => JSON.stringify(v);

// Every phase in which one of THIS BATCH's features was the thing on screen.
// An unexplained window error inside one of them is this batch's to answer.
const FEATURE_PHASES = ['badge-journey', 'disclosures', 'language', 'keyboard',
                        'inline-panel', 'declared-edit', 'filtering',
                        'view-scope', 'sidebar-exclusion'];

async function main() {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  say('\n=== The combined F27/F28 reference workflow, in one reading session ===\n');

  const writeAccounting = {
    anchorFile: `pages/${CG.ANCHOR}.md`,
    anchorBefore: null,
    joiningFile: `pages/${CG.JOINING_PAGE}.md`,
    joiningBefore: null,
  };

  // ---------- C0 : preconditions ----------
  say('C0  preconditions');
  const built = APP.resolve(FEATURE_APP);
  const v = built.preflight;
  record('C0.1', 'this build is present and passes its identity check', v.ok,
    v.ok ? `${built.appName}: build ${v.manifest.pilotBuildId}, renderer ` +
           `${v.manifest.builtFrom.rendererRevision}, branch ${v.manifest.builtFrom.branch}, ` +
           `dirty ${v.manifest.builtFrom.dirty}`
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
  const carries = (p) => names.some((n) => n.startsWith(p));
  // THE INTEGRATION PREMISE, verified rather than trusted: the packaged build
  // carries every slice this checkpoint exercises TOGETHER. A build with any
  // one of them missing would answer a different question than the one asked.
  record('C0.2', 'the packaged renderer carries every slice this run uses together',
    carries('frontend.util.f28_reforder') && carries('frontend.util.f28_refctx') &&
    carries('frontend.util.f28_refpath') && carries('frontend.util.f28_refrole') &&
    carries('frontend.util.f27_children') && carries('frontend.util.f27_inbound') &&
    carries('frontend.util.f27_outgoing') && carries('frontend.util.f27_inline'),
    `f28: order ${carries('frontend.util.f28_reforder')}, ctx ${carries('frontend.util.f28_refctx')}, ` +
    `path ${carries('frontend.util.f28_refpath')}, role ${carries('frontend.util.f28_refrole')}; ` +
    `f27: children ${carries('frontend.util.f27_children')}, inbound ${carries('frontend.util.f27_inbound')}, ` +
    `outgoing ${carries('frontend.util.f27_outgoing')}, inline ${carries('frontend.util.f27_inline')}`);
  let compiled = '';
  for (const f of names.filter((n) => n.startsWith('frontend.util.f28_reforder'))) {
    compiled += fs.readFileSync(path.join(runtime, f), 'utf8');
  }
  const has = (re) => re.test(compiled);
  record('C0.3', 'and carries the ordering rule itself, compiled',
    has(/order_groups/) && has(/compare_titles/) && has(/code_points/) && has(/NFC/),
    `order-groups ${has(/order_groups/)}, compare-titles ${has(/compare_titles/)}, ` +
    `code-points ${has(/code_points/)}, NFC ${has(/NFC/)} (${compiled.length} bytes)`);

  // ---------- C1 : a fresh graph ----------
  say('\nC1  a fresh synthetic graph');
  const g = CG.build({ kind: 'workflow' });
  const GRAPH = B.assertInsideAllowedRoot('combined graph', g.graph);
  record('C1.1', 'created fresh inside the permitted root; no earlier run reused or touched', true,
    `${GRAPH} (${g.pages} pages + ${g.journal})`);
  record('C1.2', 'the ordering fixture\'s decomposed source-page file name survived to disk',
    g.normalizationOnDisk === 'NFD',
    `on disk as ${g.normalizationOnDisk} (${J(g.onDisk)})`);
  observations.fixture = { graph: GRAPH, normalizationOnDisk: g.normalizationOnDisk,
                           onDisk: g.onDisk, journalFile: g.journalFile };
  const before = GH.snapshot(GRAPH);
  writeAccounting.anchorBefore = CG.readPage(GRAPH, writeAccounting.anchorFile);
  writeAccounting.joiningBefore = CG.readPage(GRAPH, writeAccounting.joiningFile);
  const controlBefore = CG.readPage(GRAPH, CG.CONTROL_FILE);
  record('C1.3', 'every file hashed before the application is launched',
    Object.keys(before).length >= g.pages + 2, `${Object.keys(before).length} files`);
  const declaredNames = Object.keys(CG.DECLARED_WRITES).sort();
  const writeNames = [writeAccounting.anchorFile, writeAccounting.joiningFile]
    .map((f) => f.replace(/^pages\//, '')).sort();
  record('C1.4', 'the two writes this run will ask OG for are declared in advance',
    J(declaredNames) === J(writeNames),
    () => `${Object.entries(CG.DECLARED_WRITES).map(([f, why]) => `${f} — ${why}`).join('; ')}`);
  const BAD = path.join(path.dirname(B.allowedRootReal()), 'f28-combined-inert-probe');
  record('C1.5', 'the bad-dialog probe path is outside the permitted root and inert',
    !B.isInsideAllowedRoot(BAD) && !fs.existsSync(BAD), BAD);

  // ---------- C2/C3 : launch, refuse, then open ----------
  const session = await APP.open({
    built, graph: GRAPH, bad: BAD, errors, say, record, phase, prefix: 'C',
  });
  const { page, goTo, parkPointer } = session;
  ownedTree = session.ownedTree;

  try {
    const settle = RD.makeSettle(page, session, say);
    const U = CG.UUID;
    const T = CG.TEXT;

    /** Choose an order through the control, then settle and read. */
    const choose = async (value, why) => {
      const out = { value, changed: false, error: null };
      try {
        await page.selectOption('select.f28-order-select', value, { timeout: 15000 });
        out.changed = true;
      } catch (e) {
        out.error = String(e && e.message).split('\n')[0].slice(0, 200);
      }
      await sleep(1500);
      await settle(why);
      return out;
    };

    // =====================================================================
    // Readers. Nothing below clicks: each is the observation the assertions
    // are made from, and each lives in ONE place so two checks cannot quietly
    // come to mean different measurements.
    // =====================================================================

    /**
     * The anchor page's MAIN CONTENT: the inline surface and its state, and the
     * badge journey's site. OG renders the badge on the block the references
     * point AT (`block-refs-count` counts `:block/_refs`), never on the row
     * that carries the reference — and an inline embed hides it at its own top
     * level (`hide-block-refs-count?`, block.cljs) — so what the anchor page's
     * badge row can show is the TARGET rendered inline, and the badge itself
     * is read on the target's own page, where the accepted F27 walkthrough
     * reads it.
     */
    const mainState = () => page.evaluate((uuids) => {
      const main = document.querySelector('#main-content-container') || document.body;
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const block = (uuid) => !!main.querySelector(`[blockid="${uuid}"]`);
      const inBlock = (uuid, sel) => {
        const el = main.querySelector(`[blockid="${uuid}"]`);
        return !!(el && el.querySelector(sel));
      };
      const blockText = (uuid) => {
        const el = main.querySelector(`[blockid="${uuid}"]`);
        return el ? clean(el.innerText) : null;
      };
      return {
        badgeHost: { present: block(uuids.badgeHost),
                     embedShowsTarget: (blockText(uuids.badgeHost) || '')
                       .includes(uuids.targetNeedle),
                     badgeLink: inBlock(uuids.badgeHost, 'a.open-block-ref-link') },
        hostMain: { present: block(uuids.hostMain),
                    wrapped: inBlock(uuids.hostMain, '.f27-il'),
                    toggle: inBlock(uuids.hostMain, '.f27-il-toggle') },
        overview: !!main.querySelector('.f27-ref-overview'),
        heading: clean((main.querySelector('.journal-top-bar, .page-title, h1') || {}).innerText),
        editors: document.querySelectorAll('textarea[aria-label="editing block"]').length,
        hash: location.hash,
      };
    }, { badgeHost: U.badgeHost, hostMain: U.hostMain,
         targetNeedle: T.badgeTarget.split(' ·')[0] })
      .catch((e) => ({ error: String(e.message) }));

    /**
     * Everything the F27 overview panel has on screen: its rows with their own
     * contexts and inbound sections, and the Crystal selector. Adapted from
     * the accepted integrated walkthrough's reader, unchanged in vocabulary.
     */
    const ovState = () => page.evaluate(() => {
      const p = document.querySelector('.f27-ref-overview');
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const txt = (root, sel) => (root && root.querySelector(sel)
        ? clean(root.querySelector(sel).innerText) : null);
      if (!p) return { present: false };
      return {
        present: true,
        title: txt(p, '.f27-ref-overview-title'),
        // The compact overview keeps identifiers out of the reading view; a raw
        // uuid or an `id::` on screen would be a leak of the worst kind.
        leak: { id: /id::/.test(p.innerText || ''),
                uuid: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
                  .test(p.innerText || '') },
        crystal: {
          toggle: txt(p, '.f27-crystal-config-toggle'),
          options: [...p.querySelectorAll('.f27-crystal-option')]
            .map((o) => clean(o.innerText)),
          chips: [...p.querySelectorAll('.f27-crystal-chip')].map((c) => clean(c.innerText)),
          scope: !!p.querySelector('.f27-crystal-scope'),
          clear: !!p.querySelector('.f27-crystal-clear'),
        },
        rows: [...p.querySelectorAll('.f27-ref-row')].map((r) => {
          const ctx = r.querySelector('.f27-ctx');
          const inBody = r.querySelector('.f27-in-body');
          return {
            crumb: txt(r, '.f27-ref-crumb'),
            ctxToggle: txt(r, '.f27-ctx-toggle'),
            ctxOpen: !!ctx,
            ancestors: ctx ? [...ctx.querySelectorAll('.f27-ctx-lines .f27-ctx-line')]
              .map((x) => clean(x.innerText)) : null,
            children: ctx ? [...ctx.querySelectorAll('.f27-desc-line')]
              .map((x) => clean(x.innerText)) : null,
            childBadges: ctx ? [...ctx.querySelectorAll('.f27-desc-line .f27-ctx-badge')]
              .map((x) => clean(x.innerText)) : null,
            childEmphasis: ctx ? ctx.querySelectorAll('.f27-desc-line b, .f27-desc-line strong').length : null,
            warnings: ctx ? [...ctx.querySelectorAll('.warning')].map((x) => clean(x.innerText)) : null,
            inOpen: !!inBody,
            inDirection: txt(inBody, '.f27-in-direction'),
            inPath: inBody ? [...inBody.querySelectorAll('.f27-in-path-step')]
              .map((x) => clean(x.innerText)) : null,
            inItems: inBody ? [...inBody.querySelectorAll('.f27-in-item')].map((e) => ({
              crumb: txt(e, '.f27-in-crumb'),
              text: txt(e, '.f27-in-text'),
              stop: !!e.querySelector('.f27-in-mark.is-stop'),
              mark: txt(e, '.f27-in-mark'),
              explore: !!e.querySelector('.f27-in-explore'),
              source: !!e.querySelector('.f27-in-source'),
            })) : null,
            inNote: txt(inBody, '.f27-ctx-note'),
            hasBack: !!(inBody && inBody.querySelector('.f27-in-back')),
          };
        }),
      };
    }).catch((e) => ({ present: false, error: String(e.message) }));

    /** The index of the overview row whose crumb mentions `needle`. */
    const ovRowIdx = async (needle) =>
      (await ovState()).rows.findIndex((r) => (r.crumb || '').includes(needle));

    // A toggle is a toggle: clicking a section that is already open CLOSES it,
    // and this journey re-visits rows (the cycle row is walked, taken Back,
    // and later used for source navigation). Every open is therefore made
    // conditional on the row's actual state, read rather than assumed.
    const rowNow = async (i) => {
      const s = await ovState();
      return s.present ? (s.rows[i] || null) : null;
    };
    const ensureRowCtx = async (i) => {
      let r = await rowNow(i);
      if (!r || !r.ctxOpen) {
        await parkPointer();
        await page.locator('.f27-ref-row').nth(i).locator('.f27-ctx-toggle').first()
          .click({ timeout: 15000 });
        await sleep(1600);
        r = await rowNow(i);
      }
      return r;
    };
    const ensureRowIn = async (i) => {
      let r = await ensureRowCtx(i);
      if (!r || !r.inOpen) {
        await parkPointer();
        await page.locator('.f27-ref-row').nth(i).locator('.f27-in-toggle').first()
          .click({ timeout: 15000 });
        await sleep(1900);
        r = await rowNow(i);
      }
      return r;
    };

    /**
     * The badge journeys' site, on the referenced block's OWN page: go there,
     * then scroll until lazy rendering has actually drawn the target block, and
     * read the badge OG renders on it. The target sits at the bottom of a
     * five-ancestor chain, so a plain locator wait is not enough — the block
     * must be brought into the viewport to be rendered at all.
     */
    const badgeSite = async () => {
      await goTo(CG.BADGE_PAGE);
      let site = null;
      for (let i = 0; i < 14 && !(site && site.present && site.badge); i++) {
        site = await page.evaluate((uuid) => {
          const main = document.querySelector('#main-content-container') || document.body;
          const el = main.querySelector(`[blockid="${uuid}"]`);
          const a = el ? el.querySelector('a.open-block-ref-link') : null;
          if (el) { el.scrollIntoView({ block: 'center' }); }
          else { main.scrollTop = main.scrollHeight; }
          return { present: !!el, badge: !!a, count: a ? clean0(a.innerText) : null };
          function clean0(s) { return (s || '').replace(/\s+/g, ' ').trim(); }
        }, U.badgeTarget).catch(() => null);
        if (!(site && site.present && site.badge)) await sleep(900);
      }
      await sleep(1200);
      await parkPointer();
      return site;
    };
    /** Open the overview by clicking the badge on the referenced block. */
    const clickBadge = async () => {
      await parkPointer();
      await page.locator(
        `#main-content-container [blockid="${U.badgeTarget}"] a.open-block-ref-link`)
        .first().click({ timeout: 20000 });
      await sleep(2600);
    };
    /** The badge is a toggle (`swap! *show-ref-overview? not`): close it again. */
    const closeBadge = async () => {
      await parkPointer();
      await page.locator(
        `#main-content-container [blockid="${U.badgeTarget}"] a.open-block-ref-link`)
        .first().click({ timeout: 20000 }).catch(() => {});
      await sleep(1500);
    };

    /**
     * The F28 disclosures of one linked-references reading: the source-path
     * panel of the group holding `uuid`, and the child-context panel of the
     * row `uuid` itself, each attributed to its own control.
     */
    const disclosureState = () => page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const sec = document.querySelector('.references.page-linked');
      if (!sec) return { present: false };
      const rows = [...sec.querySelectorAll('.ls-block[blockid]')];
      const readCtx = (el) => {
        const ctx = el.querySelector(':scope > .f28-ctx');
        const open = ctx ? ctx.querySelector(':scope > .f28-ctx-open') : null;
        const panel = ctx ? ctx.querySelector(':scope > .f28-ctx-panel') : null;
        return {
          control: !!open,
          controlId: open ? open.id : null,
          expanded: open ? open.getAttribute('aria-expanded') : null,
          ariaControls: open ? open.getAttribute('aria-controls') : null,
          label: open ? clean(open.innerText) : null,
          open: !!panel,
          panelId: panel ? panel.id : null,
          panelText: panel ? clean(panel.innerText).slice(0, 400) : null,
          lines: panel ? [...panel.querySelectorAll('.f28-ctx-line, .f28-ctx-item')]
            .map((l) => clean((l.querySelector('.f28-ctx-text') || l).innerText)) : null,
          hasHide: !!(panel && panel.querySelector('.f28-ctx-hide')),
        };
      };
      const byId = {};
      for (const el of rows) byId[el.getAttribute('blockid')] = readCtx(el);
      // The source-path control lives in a group's breadcrumb wrapper. OG's
      // `breadcrumb-with-container` renders the wrapped breadcrumb and the
      // rows it introduces as SIBLINGS under one parent div — the holder
      // contains no rows itself and no row contains it (the packaged probe
      // measured this directly), so a holder is identified the way OG itself
      // identifies it: `f28-panel-id` ends with the uuid of the block the
      // breadcrumb is drawn for, and the toggle id appends "-toggle". The
      // rows in the holder's parent scope are kept as evidence only.
      const UUID_RE = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
      const paths = [...sec.querySelectorAll('.f28-path')]
        .filter((holder) => holder.querySelector(':scope > .breadcrumb .f28-path-toggle'))
        .map((holder) => {
        const toggle = holder.querySelector(':scope > .breadcrumb .f28-path-toggle');
        const panel = holder.querySelector(':scope > .f28-path-panel');
        const tid = (toggle && toggle.id) || '';
        const crumbId = (new RegExp(UUID_RE + '-toggle$')).test(tid)
          ? tid.match(new RegExp(UUID_RE + '-toggle$'))[1] : null;
        const scope = holder.parentElement;
        const blocks = scope
          ? [...scope.querySelectorAll('.ls-block[blockid]')]
            .map((e) => e.getAttribute('blockid'))
          : [];
        return {
          crumbId,
          holds: blocks,
          crumb: clean((holder.querySelector(':scope > .breadcrumb') || {}).innerText),
          toggle: toggle ? {
            id: toggle.id,
            expanded: toggle.getAttribute('aria-expanded'),
            ariaControls: toggle.getAttribute('aria-controls'),
            label: clean(toggle.innerText),
          } : null,
          panel: panel ? {
            id: panel.id,
            steps: [...panel.querySelectorAll('.f28-path-step')]
              .map((li) => clean((li.querySelector('.f28-path-text') || li).innerText)),
            status: clean((panel.querySelector('.f28-path-status') || {}).innerText),
            hasHide: !!panel.querySelector('.f28-path-hide'),
            hasMore: !!panel.querySelector('.f28-path-more'),
          } : null,
        };
      });
      return {
        present: true,
        ctxById: byId,
        paths,
        ctxPanels: sec.querySelectorAll('.f28-ctx-panel').length,
        pathPanels: sec.querySelectorAll('.f28-path-panel').length,
      };
    }).catch((e) => ({ present: false, error: String(e.message) }));

    /** Press a control inside one row's own child-context panel, by block id. */
    const pressCtx = async (uuid, sel) => {
      const ok = await page.evaluate(([id, s]) => {
        const el = document.querySelector(
          `.references.page-linked .ls-block[blockid="${id}"]`);
        const panel = el ? el.querySelector(':scope > .f28-ctx > .f28-ctx-panel') : null;
        const btn = panel ? panel.querySelector(s) : null;
        if (!btn) return false;
        btn.click();
        return true;
      }, [uuid, sel]).catch(() => false);
      await sleep(2400);
      return ok;
    };

    /**
     * Press the source-path panel's own Hide control. The panel is found the
     * way OG names it: `f28-panel-id` ends with the uuid of the block the
     * breadcrumb is drawn for, so no row lookup is needed at all.
     */
    const pressPathHide = async (uuid) => {
      const ok = await page.evaluate((id) => {
        const sec = document.querySelector('.references.page-linked');
        const panel = !sec ? null : [...sec.querySelectorAll('.f28-path-panel')]
          .find((p) => p.id && p.id.endsWith(id));
        const btn = panel ? panel.querySelector('.f28-path-hide') : null;
        if (!btn) return false;
        btn.click();
        return true;
      }, uuid).catch(() => false);
      await sleep(2400);
      return ok;
    };

    /**
     * Every wrapped inline reference on the page, and the panel each has open —
     * the reader the accepted refresh scenario established, with the outgoing
     * section added because this journey reads it.
     */
    const ilState = () => page.evaluate(() => {
      const main = document.querySelector('#main-content-container') || document.body;
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const txt = (root, sel) => (root && root.querySelector(sel)
        ? clean(root.querySelector(sel).innerText) : null);
      const read = (w) => {
        const btn = w.querySelector(':scope > .f27-il-toggle');
        const panel = w.querySelector(':scope > .f27-il-panel');
        const hostEl = w.closest('[blockid]');
        const ctx = panel ? panel.querySelector('.f27-ctx') : null;
        const out = ctx ? ctx.querySelector('.f27-out') : null;
        const outBody = out ? out.querySelector('.f27-out-body') : null;
        const inBody = panel ? panel.querySelector('.f27-in-body') : null;
        return {
          hostId: hostEl ? hostEl.getAttribute('blockid') : null,
          expanded: btn ? btn.getAttribute('aria-expanded') : null,
          open: !!panel,
          panel: panel ? {
            id: panel.id,
            label: panel.getAttribute('aria-label') || '',
            crumb: txt(panel, '.f27-il-crumb'),
            snapshotNote: txt(panel, '.f27-il-snapshot'),
            refreshControls: panel.querySelectorAll('.f27-il-refresh').length,
            refreshLabel: panel.querySelector('.f27-il-refresh')
              ? (panel.querySelector('.f27-il-refresh').getAttribute('aria-label') || '') : null,
            ctxOpen: !!ctx,
            ctxToggle: txt(panel, '.f27-il-ctx-toggle'),
            outOpen: !!outBody,
            outToggle: txt(out, '.f27-out-toggle'),
            outRows: outBody ? [...outBody.querySelectorAll('.f27-out-row')].map((r) => ({
              pos: txt(r, '.f27-out-pos'),
              mark: txt(r, '.f27-out-mark'),
              label: txt(r, '.f27-out-label'),
              crumb: txt(r, '.f27-out-crumb'),
              canExpand: !!r.querySelector('.f27-out-toggle-text'),
              canOpen: !!r.querySelector('.f27-out-source'),
            })) : null,
            inOpen: !!inBody,
            inToggle: txt(panel, '.f27-in-toggle'),
            inCount: txt(panel, '.f27-in-count'),
            inTexts: [...panel.querySelectorAll('.f27-in-text')]
              .map((x) => clean(x.innerText).slice(0, 90)),
            inPath: [...panel.querySelectorAll('.f27-in-path-step')]
              .map((x) => clean(x.innerText).slice(0, 40)),
            inExplorable: panel.querySelectorAll('.f27-in-explore').length,
          } : null,
        };
      };
      return {
        main: [...main.querySelectorAll('.f27-il')].map(read),
        panels: document.querySelectorAll('.f27-il-panel').length,
        editors: document.querySelectorAll('textarea[aria-label="editing block"]').length,
        hash: location.hash,
      };
    }).catch((e) => ({ error: String(e.message), main: [] }));

    const waitFor = async (label, predicate, ms = 30000) => {
      const started = Date.now();
      let last = null;
      for (;;) {
        last = await ilState();
        let hit = false;
        try { hit = predicate(last); } catch (e) { hit = false; }
        if (hit) return { ok: true, ms: Date.now() - started, state: last };
        if (Date.now() - started > ms) return { ok: false, ms: Date.now() - started, state: last };
        await sleep(500);
      }
    };
    const wrapAt = (state, hostUuid) =>
      (state.main || []).filter((w) => w.hostId === hostUuid)[0] || null;
    const hostBlock = (uuid) =>
      page.locator(`#main-content-container [blockid="${uuid}"]`).first();
    const clickIn = async (uuid, sel, label, nth = 0) => {
      await parkPointer();
      await APP.withTimeout(hostBlock(uuid).locator(sel).nth(nth).click(), 25000, label)
        .catch((e) => say(`          (${label}: ${String(e.message).split('\n')[0]})`));
      await sleep(1700);
    };
    const openPanel = (uuid, label) => clickIn(uuid, '.f27-il-toggle', label);
    const openContext = (uuid, label) => clickIn(uuid, '.f27-il-ctx-toggle', label);
    const openOutgoing = (uuid, label) => clickIn(uuid, '.f27-out-toggle', label);
    const openInbound = async (uuid, label) => {
      await clickIn(uuid, '.f27-in-toggle', label);
      await sleep(2400);
    };
    const refresh = async (uuid, label) => {
      await clickIn(uuid, '.f27-il-refresh', label);
      await sleep(2400);
    };

    // The ORDINARY APPLICATION API. Each call goes through
    // `frontend.handler.editor` and the outliner — the same path a plugin, a
    // command or the UI itself takes. OG writes the file itself; nothing here
    // writes a file directly. Every call is recorded in `applied`.
    const api = async (fn, args, what) => {
      const r = await page.evaluate(([f, a]) => {
        const ns = globalThis.logseq && globalThis.logseq.api;
        if (!ns || typeof ns[f] !== 'function') {
          return { ok: false, error: `logseq.api.${f} is not available` };
        }
        try { ns[f].apply(null, a); return { ok: true }; }
        catch (e) { return { ok: false, error: String(e && e.message || e) }; }
      }, [fn, args]);
      applied.push({ at: new Date().toISOString(), via: `logseq.api.${fn}`, args, what,
                     ok: !!r.ok, error: r.error || null });
      say(`          ✎ logseq.api.${fn} — ${what}${r.ok ? '' : ` (FAILED: ${r.error})`}`);
      await sleep(1500);
      return r;
    };

    // Wait until OG's own file writer has gone quiet, so a hash taken next is
    // the hash of a settled graph rather than of a write in flight.
    const settleGraph = async (quietMs, maxMs) => {
      const stamp = () => {
        const out = [];
        (function walk(d) {
          for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.isFile()) {
              const st = fs.statSync(p);
              out.push(`${p}:${st.size}:${st.mtimeMs}`);
            }
          }
        })(GRAPH);
        return out.sort().join('\n');
      };
      const started = Date.now();
      let last = stamp();
      let lastChange = Date.now();
      for (;;) {
        if (Date.now() - started > maxMs) return { quiet: false, ms: Date.now() - started };
        await sleep(1000);
        const now = stamp();
        if (now !== last) { last = now; lastChange = Date.now(); }
        else if (Date.now() - lastChange >= quietMs) return { quiet: true, ms: Date.now() - started };
      }
    };

    // =====================================================================
    // C4 — the anchor page: OG's own list, and both surfaces beside it
    // =====================================================================
    say("\nC4  the anchor page: OG's own list, and both F27 surfaces beside it");
    phase('badge-journey', 'open-the-anchor-page');
    await goTo(CG.ANCHOR);
    await settle('on the anchor page');
    const original = await RD.read(page);
    observations.original = original.present ? RD.lean(original) : original;
    record('C4.1', 'the linked-references section rendered', original.present === true,
      original.present ? original.heading : `not present: ${original.error}`);
    if (!original.present) throw new Error('no linked-references section; not proceeding');

    record('C4.2', 'the list is exactly what the ordering runs measured: 10 mentions, 8 groups',
      original.heading.includes(String(CG.REFERENCING.length)) &&
      original.groups.length === 8 && original.groups.every((x) => x.ref),
      () => `"${original.heading}" for ${CG.REFERENCING.length} referencing block(s); ` +
        `${original.groups.length} group(s), ${original.rows.length} row(s)`);
    record('C4.3', 'it opens in OG\'s OWN order, journal first, with the control at rest',
      original.wrapOrder === 'original' && original.controlOrder === 'original' &&
      original.selects === 1 && original.controlInHeading === true,
      () => `list ${J(original.wrapOrder)}, control ${J(original.controlOrder)}, ` +
        `${original.selects} select in the heading ${original.controlInHeading}`);
    record('C4.4', "OG's own filter, unlinked references, no editor, and every earlier slice's " +
      'controls are all still there',
      original.filterControl === true && original.unlinked === true &&
      original.editors === 0 && original.labels === original.rows.length &&
      original.ctxControls > 0 && original.pathControls > 0,
      () => `filter ${original.filterControl}, unlinked ${original.unlinked}, ` +
        `${original.editors} editor(s), ${original.labels} role label(s) on ` +
        `${original.rows.length} row(s), ${original.ctxControls} child-context control(s), ` +
        `${original.pathControls} source-path control(s)`);
    const main = await mainState();
    observations.mainContent = main;
    record('C4.5', 'the anchor page\'s MAIN CONTENT carries the inline panel beside the list, ' +
      'and the badge row renders its target inline — OG keeps the badge itself for the ' +
      'referenced block\'s own page',
      !!main.badgeHost && main.badgeHost.present && main.badgeHost.embedShowsTarget &&
      main.badgeHost.badgeLink === false &&
      !!main.hostMain && main.hostMain.present && main.hostMain.wrapped && main.hostMain.toggle &&
      main.overview === false,
      () => `badge row renders the target inline ` +
        `${main.badgeHost && main.badgeHost.embedShowsTarget} (its own badge ` +
        `${main.badgeHost && main.badgeHost.badgeLink}, which OG hides at an embed\'s top ` +
        `level); inline host ${main.hostMain && main.hostMain.present} (wrapped ` +
        `${main.hostMain && main.hostMain.wrapped}, toggle ` +
        `${main.hostMain && main.hostMain.toggle}); overview open before any click: ` +
        `${main.overview}`);

    // The keys the order is decided by, from the titles the application holds.
    const live = original.groups.map((x) => ({ ref: x.ref, title: x.title }));
    const expectAsc = CG.orderTitles(live, 'title-asc').map((x) => x.ref);
    const expectDesc = CG.orderTitles(live, 'title-desc').map((x) => x.ref);
    observations.expected = { ascending: expectAsc, descending: expectDesc };
    const originalOrder = RD.orderOf(original);
    // RD.insideOf is ORDER-SENSITIVE and load-bearing for the accepted 65/65
    // reforder-feature scenario, so it stays untouched. But the combined
    // workflow compares ACROSS VIEWS, and the fourth run measured that OG's
    // 'original' sequence is nondeterministic at TWO granularities: the group
    // sequence per view (P13.2, recorded), AND the per-parent CONTAINER
    // order INSIDE a multi-parent group, because `->hiccup`'s custom-query
    // branch assembles containers from `(group-by :block/parent)`, a hash map
    // whose iteration order is whatever this rendering produced (probe runs 1
    // and 2 drew 나/가 containers in different orders; run 4 differed across
    // re-entry/reorder re-renders for exactly the two multi-parent groups).
    // The supervisor review (2026-09-10) closed the gap this first cut left:
    // sorting every row id and tuple also erased SIBLING ORDER inside each
    // container. Cross-view comparison is now IDENTITY-SCOPED — the shared
    // module below reduces each group to a MULTISET OF CONTAINERS (container
    // order tolerated, the documented nondeterminism), each container
    // retaining its rows as an ORDERED, duplicate-preserving list keyed by
    // parent block id — its semantics are asserted by
    // f28-refpath/tests/inside-containers.test.js. The row's PROSE text is
    // deliberately not compared: RD.read takes it from main.innerText, which
    // carries the TRANSLATED control words, and C7.4 must hold across a
    // language switch; prose changes are the declared-write accounting's job
    // (C12.4), not this comparator's.
    const insideSetOf = IC.insideSetOf;
    const insideCompare = IC.insideCompare;
    const originalInside = insideSetOf(original);

    // =====================================================================
    // C5 — JOURNEY 1: the badge, the overview, the Crystal marker, a context,
    //      a cycle, a source, and back
    // =====================================================================
    say('\nC5  journey 1: the badge → the compact overview → Crystal → context → cycle → source');
    phase('badge-journey', 'open-the-overview-from-the-badge');
    // OG's badge belongs to the REFERENCED block, on its own page (the accepted
    // F27 walkthrough's model); the anchor page's badge row shows the target
    // rendered inline, but its badge is hidden at the embed's top level. The
    // journey therefore starts on the badge target's own page.
    const site = await badgeSite();
    observations.badgeSite = site;
    record('C5.0', 'the badge sits on the block the references point AT, on its own page, ' +
      'counting its incoming references',
      !!site && site.present && site.badge && site.count === String(CG.BADGE_INBOUND),
      () => `target block rendered ${site && site.present}; badge present ` +
        `${site && site.badge}, counting ${J(site && site.count)} source(s)`);
    await clickBadge();
    const ov1 = await ovState();
    observations.overview = ov1;
    record('C5.1', 'the badge on the referenced block opens the compact overview, counting ' +
      'every source',
      ov1.present === true && ov1.title &&
      ov1.title.includes(String(CG.BADGE_INBOUND)) && ov1.rows.length === CG.BADGE_INBOUND,
      () => ov1.present ? `title ${J(ov1.title)}, ${ov1.rows.length} row(s)` : 'no overview');
    record('C5.2', 'every row carries its own source page in its breadcrumb, and no raw ' +
      'identifier leaks into the reading view',
      ov1.present &&
      ov1.rows.some((r) => (r.crumb || '').includes(CG.ANCHOR)) &&
      ov1.rows.some((r) => (r.crumb || '').includes(CG.CYCLE_PAGE)) &&
      ov1.rows.some((r) => (r.crumb || '').includes(CG.THIRD_PAGE)) &&
      !ov1.leak.id && !ov1.leak.uuid,
      () => `${J(ov1.rows.map((r) => (r.crumb || '').slice(0, 40)))}; leak ` +
        `${J(ov1.leak)}`);

    phase('badge-journey', 'choose-preview-and-clear-a-crystal-marker');
    await parkPointer();
    await page.locator('.f27-ref-overview .f27-crystal-config-toggle').first()
      .click({ timeout: 15000 });
    await sleep(1100);
    const ovOpt = await ovState();
    observations.crystalOptions = ovOpt.crystal ? ovOpt.crystal.options : null;
    record('C5.3', 'the Crystal marker list offers the graph\'s own tags, more than one',
      ovOpt.present && ovOpt.crystal.options.length >= 2 &&
      ovOpt.crystal.options.some((o) => o.includes('핵심')) &&
      ovOpt.crystal.options.some((o) => o.includes('question')),
      () => `options ${J(ovOpt.crystal ? ovOpt.crystal.options : null)}`);
    const coreIdx = ovOpt.crystal.options.findIndex((o) => o.includes('핵심'));
    await parkPointer();
    await page.locator('.f27-ref-overview .f27-crystal-option').nth(coreIdx)
      .click({ timeout: 15000 });
    await sleep(1700);
    const ovMarked = await ovState();
    observations.crystalChosen = ovMarked.crystal;
    record('C5.4', 'the chosen marker previews beside exactly the rows that carry it, and ' +
      'states its scope',
      ovMarked.present && ovMarked.crystal.chips.length >= 2 &&
      ovMarked.crystal.scope === true && /Crystal/.test(ovMarked.crystal.toggle || ''),
      () => `${ovMarked.crystal.chips.length} preview chip(s) ` +
        `${J(ovMarked.crystal.chips)}; toggle ${J(ovMarked.crystal.toggle)}; ` +
        `scope stated ${ovMarked.crystal.scope}`);
    await parkPointer();
    await page.locator('.f27-ref-overview .f27-crystal-clear').first()
      .click({ timeout: 15000 }).catch(() => {});
    await sleep(1500);
    const ovCleared = await ovState();
    record('C5.5', 'and the marker clears again, leaving the rows as they were',
      ovCleared.present && ovCleared.crystal.chips.length === 0,
      () => `${ovCleared.crystal.chips.length} chip(s) after clearing`);

    phase('badge-journey', 'disclose-one-rows-ancestors-and-children');
    const iHost = await ovRowIdx(CG.ANCHOR);
    const hostRow = await ensureRowCtx(iHost);
    observations.badgeHostContext = hostRow;
    record('C5.6', 'the row\'s context shows its ancestor, and on request its children with ' +
      'their own words intact',
      !!hostRow && hostRow.ctxOpen &&
      hostRow.ancestors.some((a) => a.includes('핵심으로 묶은 상위')) &&
      (hostRow.children || []).length === 0,
      () => `ancestors ${J(hostRow && hostRow.ancestors)}; children before the disclosure ` +
        `${J(hostRow && hostRow.children)}`);
    await parkPointer();
    await page.locator('.f27-ref-row').nth(iHost).locator('.f27-desc-toggle-all').first()
      .click({ timeout: 15000 });
    await sleep(1600);
    const ovKids = await ovState();
    const kidRow = ovKids.rows[iHost];
    observations.badgeHostChildren = { lines: kidRow.children, badges: kidRow.childBadges };
    record('C5.7', 'the children disclosure lists the row\'s own child',
      !!kidRow && (kidRow.children || []).some((c) => c.includes('배지 참조의 자식')),
      () => `${J(kidRow && kidRow.children)}`);
    await parkPointer();
    await page.locator('.f27-ref-row').nth(iHost).locator('.f27-ctx-toggle').first()
      .click({ timeout: 15000 });
    await sleep(1300);

    phase('badge-journey', 'walk-the-inbound-explorer-into-the-cycle');
    const iCyc = await ovRowIdx(CG.CYCLE_PAGE);
    await ensureRowCtx(iCyc);
    const cycRow1 = await ensureRowIn(iCyc);
    observations.cycleLevel1 = cycRow1;
    record('C5.8', 'the first step of the inbound walk lists what references the cycle row, ' +
      'and states the direction in words',
      !!cycRow1 && cycRow1.inOpen && cycRow1.inItems.length === 1 &&
      (cycRow1.inItems[0].crumb || '').includes(CG.BADGE_PAGE) &&
      (cycRow1.inItems[0].text || '').includes('배지 대상 본문') &&
      /refer TO the selected block|refer TO this one/.test(cycRow1.inDirection || ''),
      () => `direction ${J(cycRow1 && cycRow1.inDirection)}; items ` +
        `${J(cycRow1 && cycRow1.inItems.map((i) => i.crumb))}`);
    await parkPointer();
    await page.locator('.f27-ref-row').nth(iCyc).locator('.f27-in-item').nth(0)
      .locator('.f27-in-explore').first().click({ timeout: 15000 });
    await sleep(2000);
    const cyc2 = await ovState();
    const cycRow2 = cyc2.rows[iCyc];
    observations.cycleLevel2 = cycRow2;
    // At level 2 the walk asks what references the BADGE TARGET: its three
    // sources. The one already on the path — the cycle row the walk started
    // from — must be marked a boundary and offered no way further. The row is
    // found by its CRUMB, not its text: every level-2 item embeds the badge
    // target inline, and the target's own text embeds the cycle row right
    // back, so the cycle row's words appear inside EVERY item here — only the
    // crumb (the item's own source page and ancestors) tells the rows apart.
    const boundary = cycRow2 && cycRow2.inItems
      ? cycRow2.inItems.find((i) => (i.crumb || '').includes(CG.CYCLE_PAGE)) : null;
    record('C5.9', 'the second step meets the row the walk started from, and marks it a ' +
      'boundary rather than following it',
      !!cycRow2 && cycRow2.inItems.length === CG.BADGE_INBOUND && !!boundary &&
      (boundary.text || '').includes('순환 짝의 참조') &&
      boundary.stop === true && boundary.explore === false,
      () => `${cycRow2 ? cycRow2.inItems.length : 0} item(s) at level 2; the boundary: ` +
        `crumb ${J(boundary && boundary.crumb)}, stop ${boundary && boundary.stop}, ` +
        `explore ${boundary && boundary.explore}, mark ${J(boundary && boundary.mark)}`);
    const ctxNow = await ovState();
    const ctxWarnings = (ctxNow.rows[iCyc] || {}).warnings || [];
    record('C5.10', 'the mutual pair is previewed and never recursed: no OG depth warning',
      ctxWarnings.length === 0, J(ctxWarnings));
    await parkPointer();
    await page.locator('.f27-ref-row').nth(iCyc).locator('.f27-in-back').first()
      .click({ timeout: 15000 });
    await sleep(1700);
    const cycBack = await ovState();
    const backRow = cycBack.rows[iCyc];
    observations.cycleBack = backRow;
    record('C5.11', 'Back returns to the previous step exactly',
      !!backRow && backRow.inItems.length === 1 &&
      (backRow.inItems[0].text || '').includes('배지 대상 본문'),
      () => `${J(backRow && backRow.inItems.map((i) => i.crumb))}, path ` +
        `${J(backRow && backRow.inPath)}`);

    phase('badge-journey', 'an-empty-answer-and-source-navigation');
    const iThird = await ovRowIdx(CG.THIRD_PAGE);
    const thirdRow = await ensureRowIn(iThird);
    observations.thirdEmpty = thirdRow;
    record('C5.12', 'a row nothing references says so plainly',
      !!thirdRow && thirdRow.inOpen && thirdRow.inItems.length === 0 &&
      /No block in this graph references this one/.test(thirdRow.inNote || ''),
      () => J(thirdRow && thirdRow.inNote));
    await parkPointer();
    await page.locator('.f27-ref-row').nth(iThird).locator('.f27-ctx-toggle').first()
      .click({ timeout: 15000 });
    await sleep(1300);

    // Source navigation, read-only, and it leaves the page. The overview sits
    // on the badge target's own page, so the journey's real cross-page
    // navigation is the walk's SECOND level, which lists the target's own
    // sources: the item naming the badge-host row lives on the ANCHOR page.
    // The control's documented behaviour — go to the referring block's own
    // page — routes by BLOCK uuid (`redirect-to-page!` accepts one), and OG's
    // own page component builds a block-scoped view for that route: the block's
    // breadcrumb and its tree, with the references sections only for page
    // routes (`when-not block?`, page.cljs). The return is therefore the
    // reader's own page navigation, and the list it comes back to is what the
    // return measures. The row's context and inbound section are still open
    // from the walk and its Back — opened conditionally, so nothing toggles.
    const iCyc2 = await ovRowIdx(CG.CYCLE_PAGE);
    await ensureRowIn(iCyc2);
    // Level 1 lists the badge target; walk one step further, to the level that
    // lists the target's own sources.
    await parkPointer();
    await page.locator('.f27-ref-row').nth(iCyc2).locator('.f27-in-item').nth(0)
      .locator('.f27-in-explore').first().click({ timeout: 15000 });
    await sleep(2000);
    const hashBeforeNav = await page.evaluate(() => location.hash).catch(() => null);
    await parkPointer();
    await page.locator('.f27-ref-row').nth(iCyc2)
      .locator('.f27-in-item', { hasText: '배지가 붙는 참조' }).first()
      .locator('.f27-in-source').first().click({ timeout: 15000 });
    await sleep(3000);
    // The landing view renders lazily; scroll until the badge-host block —
    // the source the control names — is on screen.
    let nav = null;
    for (let i = 0; i < 12; i++) {
      nav = await page.evaluate((uuid) => ({
        hash: location.hash,
        onSource: !!document.querySelector(`#main-content-container [blockid="${uuid}"]`),
        overview: !!document.querySelector('#main-content-container .f27-ref-overview'),
      }), U.badgeHost).catch(() => null);
      if (nav && nav.onSource) break;
      await page.evaluate(() => {
        const m = document.querySelector('#main-content-container') || document.body;
        m.scrollTop = m.scrollHeight;
      }).catch(() => null);
      await sleep(900);
    }
    observations.sourceNavigation = { from: hashBeforeNav, after: nav };
    record('C5.13', 'the source control navigates to the referring block — OG\'s block-scoped ' +
      'view of it, on its own page — and the overview it leaves behind does not follow',
      !!nav && ((nav.hash || '').includes(U.badgeHost) || nav.onSource === true) &&
      nav.overview === false,
      () => `hash ${J(nav && nav.hash)}; the badge-host block on screen ` +
        `${nav && nav.onSource}; overview still on screen ${nav && nav.overview}`);
    // OG's block-scoped view carries no linked-references list of its own; the
    // return is the reader's page navigation, and the list must be exactly
    // what the session left.
    const blockViewRead = await RD.read(page);
    observations.blockView = { present: blockViewRead.present };
    await goTo(CG.ANCHOR);
    await settle('back on the anchor page');
    const afterReturn = await RD.read(page);
    // The packaged ordering run's own recorded lesson (P13.2): a fresh view's
    // OG-'original' group SEQUENCE is that view's own first-rendered choice —
    // the same page can re-enter with a different 'original' sequence, while
    // the CONTENT does not change. So the return is held to the content, not
    // the coin flip: the same group set, and each group's rows, nesting and
    // breadcrumbs key-wise identical. The sequence itself is observed.
    const returnedInside = insideSetOf(afterReturn);
    const sameSet = J([...RD.orderOf(afterReturn)].sort()) === J([...originalOrder].sort());
    const returnDiffs = insideCompare(originalInside, returnedInside);
    // Retained as ordered observations so a later review can re-evaluate the
    // comparison without a fresh run (what run 5 could not offer: lean dropped
    // `rows`, and the readings behind the comparisons were not retained).
    observations.insideScopes = {};
    observations.insideScopes.c5_14 = { base: originalInside, after: returnedInside,
                                        diffs: returnDiffs };
    // This view's own 'original' — the baseline every later comparison ON
    // THIS VIEW must use (the reorders of C6 and the keyboard of C7).
    const viewOriginalOrder = RD.orderOf(afterReturn).slice();
    record('C5.14', 'and the return finds the list exactly as the session left it',
      blockViewRead.present === false &&
      afterReturn.present === true && sameSet && returnDiffs.length === 0 &&
      afterReturn.controlOrder === 'original' && afterReturn.editors === 0,
      () => `the block-scoped landing held no list, as OG builds it: ` +
        `${blockViewRead.present}; back on the page, group set identical ` +
        `${sameSet}, every group's containers identical as identity-scoped ` +
        `multisets — within-container row order, parentage, membership, role, ` +
        `level and breadcrumb path compared exactly, duplicate occurrences ` +
        `retained, container order across containers tolerated (OG's ` +
        `documented per-render nondeterminism): ${returnDiffs.length} ` +
        `difference(s)${returnDiffs.length ? ` — ${returnDiffs.join('; ')}` : ''}; ` +
        `control ${J(afterReturn.controlOrder)}, ` +
        `${afterReturn.editors} editor(s)\n          this view's own 'original' ` +
        `sequence ${J(viewOriginalOrder)}\n          (the first view's was ` +
        `${J(originalOrder)} — OG's per-view choice, observed, not asserted)`);

    // =====================================================================
    // C6 — JOURNEY 3: two disclosures open, the groups reordered under them,
    //      and the controls still operating on their own blocks afterwards
    // =====================================================================
    say('\nC6  journey 3: two disclosures open, the groups reordered under them');
    phase('disclosures', 'open-the-source-path-and-child-context-panels');
    const disclose = await disclosureState();
    const applePath = disclose.paths
      ? disclose.paths.find((p) => p.crumbId === U.appleRef) : null;
    record('C6.1', 'OG\'s own breadcrumb still elides the apple chain, and the source-path ' +
      'control sits exactly there',
      !!applePath && applePath.toggle && applePath.crumb.includes('⋯') &&
      applePath.toggle.expanded === 'false',
      () => `crumb ${J(applePath && applePath.crumb)}`);
    if (applePath && applePath.toggle) {
      await parkPointer();
      await page.locator(`.f28-path-toggle[id="${applePath.toggle.id}"]`).first()
        .click({ timeout: 15000 });
    }
    await sleep(2200);
    const pathOpen = await disclosureState();
    const applePathOpen = pathOpen.paths.find((p) => p.crumbId === U.appleRef);
    observations.pathPanel = applePathOpen && applePathOpen.panel;
    // C6.2 premise, corrected by the fourth run's own evidence: the panel
    // discloses exactly the levels OG's breadcrumb CUT — not the whole chain
    // again. The apple crumb already shows ancestors 3, 4, 5; the panel shows
    // the 2 hidden ones, outermost first (사과 조상 1, then 사과 조상 2), and
    // its status says the whole path is now shown: these 2 here plus the 3
    // above. This is the accepted refpath scenario's own model (P6.2–P6.4:
    // `steps.length === hidden`, /whole path/i, hasMore false, hasHide true).
    record('C6.2', 'the panel discloses exactly the levels the crumb cut, and says ' +
      'the whole path is shown: these plus the ones above',
      !!applePathOpen && applePathOpen.panel &&
      applePathOpen.panel.steps.length === 2 &&
      applePathOpen.panel.steps[0].includes('사과 조상 1') &&
      applePathOpen.panel.steps[1].includes('사과 조상 2') &&
      /whole path/i.test(applePathOpen.panel.status) &&
      applePathOpen.panel.hasMore === false && applePathOpen.panel.hasHide === true,
      () => `${(applePathOpen.panel.steps || []).length} disclosed step(s) ` +
        `${J(applePathOpen.panel.steps)}; status ${J(applePathOpen.panel.status)}; ` +
        `more ${applePathOpen.panel.hasMore}, hide ${applePathOpen.panel.hasHide}`);
    const zebraCtxClosed = pathOpen.ctxById ? pathOpen.ctxById[U.zebraG1] : null;
    record('C6.3', 'the zebra row behind OG\'s level wall still offers the child-context control',
      !!zebraCtxClosed && zebraCtxClosed.control && zebraCtxClosed.expanded === 'false',
      () => `control ${!!zebraCtxClosed}, expanded ${zebraCtxClosed && zebraCtxClosed.expanded}`);
    if (zebraCtxClosed && zebraCtxClosed.control) {
      await page.evaluate((uuid) => {
        const el = document.querySelector(
          `.references.page-linked .ls-block[blockid="${uuid}"] .f28-ctx-open`);
        if (el) el.scrollIntoView({ block: 'center' });
      }, U.zebraG1).catch(() => null);
      await page.locator(`.references.page-linked .ls-block[blockid="${U.zebraG1}"] > .f28-ctx > .f28-ctx-open`)
        .first().click({ timeout: 15000 });
    }
    await sleep(2400);
    const both = await disclosureState();
    const zebraCtxOpen = both.ctxById ? both.ctxById[U.zebraG1] : null;
    observations.ctxPanel = zebraCtxOpen;
    record('C6.4', 'the child-context panel shows the grandchild OG was holding back, and ' +
      'both panels are open at once, in two different groups',
      !!zebraCtxOpen && zebraCtxOpen.open &&
      (zebraCtxOpen.panelText || '').includes('얼룩말 증손') &&
      both.pathPanels === 1 && both.ctxPanels === 1,
      () => `ctx panel ${zebraCtxOpen && zebraCtxOpen.open} ` +
        `(증손 inside: ${(zebraCtxOpen && zebraCtxOpen.panelText || '').includes('얼룩말 증손')}); ` +
        `${both.pathPanels} path panel(s), ${both.ctxPanels} ctx panel(s) open`);
    // What the two open panels are, before anything moves. Either may be
    // absent when its own check failed — the invariants below then have
    // nothing to hold and must say so, not crash.
    const beforeCtxPanelId = zebraCtxOpen && zebraCtxOpen.panelId;
    const beforeCtxAria = zebraCtxOpen && zebraCtxOpen.ariaControls;
    const beforePathSteps = applePathOpen && applePathOpen.panel
      ? applePathOpen.panel.steps.slice() : null;

    phase('disclosures', 'reorder-the-groups-under-the-open-panels');
    const reorderInvariant = async (tag, expected, label) => {
      const d = await disclosureState();
      const r = await RD.read(page);
      const zc = d.ctxById ? d.ctxById[U.zebraG1] : null;
      const ap = d.paths ? d.paths.find((p) => p.crumbId === U.appleRef) : null;
      const okPanels = !!zc && zc.open && !!ap && !!ap.panel &&
        zc.panelId === beforeCtxPanelId && zc.ariaControls === beforeCtxAria &&
        beforePathSteps !== null && J(ap.panel.steps) === J(beforePathSteps) &&
        (zc.panelText || '').includes('얼룩말 증손');
      record(tag, `${label}: both panels still open, still their own block\'s, same content`,
        okPanels && J(RD.orderOf(r)) === J(expected),
        () => `ctx panel ${zc && zc.open} (id ${zc && zc.panelId}, aria-controls ` +
          `${zc && zc.ariaControls}, 증손 inside ` +
          `${(zc && zc.panelText || '').includes('얼룩말 증손')}); path steps ` +
          `${ap && ap.panel ? ap.panel.steps.length : 0}; groups now ` +
          `${J(RD.orderOf(r))}`);
    };
    const ascPick = await choose('title-asc', 'under title-ascending, panels open');
    await reorderInvariant('C6.5', expectAsc, 'ascending');
    const descPick = await choose('title-desc', 'under title-descending, panels open');
    await reorderInvariant('C6.6', expectDesc, 'descending');
    const backPick = await choose('original', 'back under the original order, panels open');
    await reorderInvariant('C6.7', viewOriginalOrder, 'restored');
    record('C6.8', 'and all three orders really were applied by the control',
      ascPick.changed && descPick.changed && backPick.changed,
      `asc ${ascPick.changed}, desc ${descPick.changed}, original ${backPick.changed}`);

    phase('disclosures', 'operate-the-controls-after-the-reorder');
    // NOT MERELY THAT THE IDS MATCH: toggle each control and read what its
    // panel does. A control whose panel was rebuilt around another block would
    // disclose the wrong content here, whatever its aria-controls says.
    await page.locator(`.references.page-linked .ls-block[blockid="${U.zebraG1}"] > .f28-ctx > .f28-ctx-open`)
      .first().click({ timeout: 15000 });
    await sleep(2200);
    const ctxShut = await disclosureState();
    const zebraCtxShut = ctxShut.ctxById ? ctxShut.ctxById[U.zebraG1] : null;
    record('C6.9', 'after the reorder the child-context control still closes ITS OWN panel',
      !!zebraCtxShut && zebraCtxShut.open === false &&
      zebraCtxShut.expanded === 'false' && zebraCtxShut.panelId === null,
      () => `open ${zebraCtxShut && zebraCtxShut.open}, expanded ` +
        `${zebraCtxShut && zebraCtxShut.expanded}, panel id ${J(zebraCtxShut && zebraCtxShut.panelId)}`);
    await page.locator(`.references.page-linked .ls-block[blockid="${U.zebraG1}"] > .f28-ctx > .f28-ctx-open`)
      .first().click({ timeout: 15000 });
    await sleep(2400);
    const ctxReopen = await disclosureState();
    const zebraCtxRe = ctxReopen.ctxById ? ctxReopen.ctxById[U.zebraG1] : null;
    record('C6.10', 'and reopens the same block\'s children, not another row\'s',
      !!zebraCtxRe && zebraCtxRe.open &&
      (zebraCtxRe.panelText || '').includes('얼룩말 증손'),
      () => `panel text ${J((zebraCtxRe && zebraCtxRe.panelText || '').slice(0, 120))}`);
    const okHide = await pressCtx(U.zebraG1, '.f28-ctx-hide');
    const ctxHidden = await disclosureState();
    const zebraCtxHidden = ctxHidden.ctxById ? ctxHidden.ctxById[U.zebraG1] : null;
    record('C6.11', 'the panel\'s own Hide control closes it too',
      okHide && !!zebraCtxHidden && zebraCtxHidden.open === false,
      () => `hide pressed ${okHide}, open ${zebraCtxHidden && zebraCtxHidden.open}`);
    // The path panel's own Hide control, INSIDE the panel.
    const pathHidden = await pressPathHide(U.appleRef);
    const focusAfterHide = await page.evaluate(() => ({
      id: document.activeElement ? document.activeElement.id : null,
      tag: document.activeElement ? document.activeElement.tagName : null,
    })).catch(() => null);
    const pathShut = await disclosureState();
    const applePathShut = pathShut.paths.find((p) => p.crumbId === U.appleRef);
    record('C6.12', 'and the source-path panel closes from its own Hide control, leaving ' +
      'its toggle collapsed',
      pathHidden && !!applePathShut && applePathShut.panel === null &&
      applePathShut.toggle.expanded === 'false',
      () => `hide pressed ${pathHidden}; panel ${applePathShut && applePathShut.panel}, ` +
        `expanded ${applePathShut && applePathShut.toggle.expanded}; focus now ` +
        `${focusAfterHide && focusAfterHide.tag}#${focusAfterHide && focusAfterHide.id}`);
    // Nothing inside any group moved across the whole reorder. Cross-rendering
    // comparison, so it is identity-scoped (see `inside-containers.js`): the
    // reorders and the re-renders they force can redraw a multi-parent group's
    // containers in a different order — tolerated — but the rows INSIDE each
    // container keep their order, parentage, membership, roles, levels and
    // breadcrumb paths, and duplicate occurrences are counted, so a sibling
    // reversal or a dropped/duplicated row under the reorders FAILS here.
    const finalRead = await RD.read(page);
    const finalInside = insideSetOf(finalRead);
    const insideDiffs = insideCompare(originalInside, finalInside);
    observations.insideScopes.c6_13 = { base: originalInside, after: finalInside,
                                        diffs: insideDiffs };
    record('C6.13', 'and inside every group nothing moved: same rows in the same order, ' +
      'same nesting, same breadcrumbs',
      insideDiffs.length === 0,
      () => insideDiffs.length ? `differs: ${insideDiffs.join('; ')}` :
        `${Object.keys(originalInside).length} group(s) compared as identity-scoped ` +
        `container multisets — within-container row order, parentage, membership, ` +
        `role, level and breadcrumb path exact, duplicates retained; only the ` +
        `order of whole containers across each other is tolerated (OG's ` +
        `documented per-render nondeterminism) — 0 differences`);

    // =====================================================================
    // C7 — JOURNEY 5a: Korean and English, and the keyboard
    // =====================================================================
    say('\nC7  journey 5a: Korean and English across every slice, and the keyboard');
    phase('language', 'read-the-labels-in-english');
    const readLabels = () => page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const sec = document.querySelector('.references.page-linked');
      const sel = document.querySelector('select.f28-order-select');
      const out = {
        orderLabel: sel ? sel.getAttribute('aria-label') : null,
        orderOptions: sel ? [...sel.options].map((o) => clean(o.textContent)) : [],
        ctxOpen: null, pathToggle: null,
      };
      if (sec) {
        const ctxBtn = sec.querySelector('.f28-ctx-open');
        const pathBtn = sec.querySelector('.f28-path-toggle');
        out.ctxOpen = ctxBtn ? clean(ctxBtn.innerText) : null;
        // The path toggle's INNER text is the `⋯` mark, `aria-hidden` by
        // design — the words live in the control's `aria-label`/`title`, which
        // the product draws through `t` (`f28-source-path`). Run 4 read the
        // mark and so compared nothing translatable.
        out.pathToggle = pathBtn ? clean(pathBtn.getAttribute('aria-label') || '') : null;
      }
      return out;
    }).catch(() => null);
    const labelsEn = await readLabels();
    const setLanguage = (lang) => page.evaluate((l) => {
      const st = window.frontend && window.frontend.state;
      const fn = st && st.set_preferred_language_BANG_;
      if (typeof fn !== 'function') return { ok: false, reason: 'no language seam' };
      fn(l);
      return { ok: true };
    }, lang).catch((e) => ({ ok: false, reason: String(e.message) }));
    const switched = await setLanguage('ko');
    await sleep(3500);
    await settle('in Korean');
    // The language changes on THIS view, before any navigation: the "not a
    // locale" comparison is same-view, so no page re-entry can explain a
    // difference. The badge-page round-trip below re-enters the page, so what
    // comes back is compared by CONTENT (P13.2: a fresh view may choose its
    // own 'original' sequence), with the sequence observed.
    const koSameView = await RD.read(page);
    const labelsKo = await readLabels();
    // The F27 overview's own words, read in Korean: reopen the panel briefly,
    // on the referenced block's own page, where the badge lives.
    const siteKo = await badgeSite();
    observations.badgeSiteKorean = siteKo;
    if (siteKo && siteKo.badge) await clickBadge();
    const ovKo = await ovState();
    observations.korean = { english: labelsEn, korean: labelsKo,
                            overview: { title: ovKo.title, ctxToggle: ovKo.rows[0] && ovKo.rows[0].ctxToggle,
                                        crystalToggle: ovKo.crystal.toggle } };
    // The badge is a toggle (`swap! *show-ref-overview? not`): clicking it again
    // closes the overview, and the journey returns to the anchor page, where
    // the later journeys need it.
    if (ovKo.present) await closeBadge();
    await goTo(CG.ANCHOR);
    await settle('back on the anchor page, still in Korean');
    record('C7.1', 'the interface language really changed', switched.ok === true,
      switched.ok ? 'frontend.state/set-preferred-language! → ko' : `not switched: ${switched.reason}`);
    record('C7.2', 'the ordering control\'s own words are Korean, and none stayed English',
      !!labelsKo && /[가-힣]/.test(labelsKo.orderLabel || '') &&
      labelsKo.orderOptions.length === 3 &&
      labelsKo.orderOptions.every((o) => /[가-힣]/.test(o)) &&
      !labelsKo.orderOptions.some((o) => /Source page title/i.test(o)),
      () => `aria-label ${J(labelsKo && labelsKo.orderLabel)}, options ` +
        `${J(labelsKo && labelsKo.orderOptions)}`);
    record('C7.3', 'and so are BOTH F28 disclosures\' and the F27 overview\'s — every slice ' +
      'carries the language, together',
      !!labelsKo && /[가-힣]/.test(labelsKo.ctxOpen || '') &&
      /[가-힣]/.test(labelsKo.pathToggle || '') &&
      !!ovKo.rows[0] && /[가-힣]/.test(ovKo.rows[0].ctxToggle || '') &&
      /[가-힣]/.test(ovKo.title || ''),
      () => `f28 ctx ${J(labelsKo && labelsKo.ctxOpen)}, f28 path aria-label ` +
        `${J(labelsKo && labelsKo.pathToggle)}; f27 overview title ${J(ovKo.title)}, ` +
        `row context ${J(ovKo.rows[0] && ovKo.rows[0].ctxToggle)}`);
    const koRead = await RD.read(page);
    // Same view, before any navigation: the language alone cannot reorder.
    // After the badge-page round-trip, the page re-entered — so the group SET
    // and every group's content are compared (P13.2 + the container order of
    // `insideSetOf`), the sequence observed.
    const koInside = insideSetOf(koRead);
    const koSameSet = J([...RD.orderOf(koRead)].sort()) === J([...RD.orderOf(finalRead)].sort());
    const koDiffs = insideCompare(finalInside, koInside);
    observations.insideScopes.c7_4 = { base: finalInside, after: koInside, diffs: koDiffs };
    record('C7.4', 'the ORDER is unchanged by the language — the rule is not a locale — and ' +
      'the graph\'s own Korean and emoji still read correctly',
      koSameView.present === true &&
      J(RD.orderOf(koSameView)) === J(RD.orderOf(finalRead)) &&
      koRead.present && koSameSet && koDiffs.length === 0 &&
      koRead.groups.every((x) => !/�/.test(x.title)) &&
      koRead.groups.some((x) => /[가-힣]/.test(x.title)),
      () => `same view, language alone — English ${J(RD.orderOf(finalRead))}\n          ` +
        `Korean  ${J(RD.orderOf(koSameView))}\n          after the badge-page ` +
        `round-trip: group set identical ${koSameSet}, containers identical ` +
        `as identity-scoped multisets with within-container order exact ` +
        `(translated control words live inside each row's prose text and are ` +
        `deliberately outside this comparison): ${koDiffs.length} difference(s)` +
        `${koDiffs.length ? ` — ${koDiffs.join('; ')}` : ''}; this view's own ` +
        `'original' ${J(RD.orderOf(koRead))}`);
    await setLanguage('en');
    await sleep(3000);
    await settle('back in English');
    // The view the keyboard phase operates on, and its own 'original'.
    const enRead = await RD.read(page);
    const enOriginal = RD.orderOf(enRead);

    phase('keyboard', 'operate-the-ordering-and-a-disclosure-from-the-keyboard');
    await page.evaluate(() => {
      const sec = document.querySelector('.references.page-linked');
      const first = sec && sec.querySelector('.references-blocks-item a[tabindex], ' +
                                             '.references-blocks-item a[href]');
      if (first) first.focus();
    }).catch(() => null);
    const kb = { reached: false, routes: [] };
    const isSelect = () => page.evaluate(() =>
      !!(document.activeElement && document.activeElement.classList &&
         document.activeElement.classList.contains('f28-order-select'))).catch(() => false);
    for (let i = 0; i < 6 && !kb.reached; i++) {
      await page.keyboard.press('Shift+Tab');
      await sleep(250);
      kb.reached = await isSelect();
      kb.shiftTabPresses = i + 1;
    }
    record('C7.5', 'the ordering control is reachable with the keyboard alone',
      kb.reached === true,
      kb.reached ? `Shift+Tab from the first link inside the list, ${kb.shiftTabPresses} press(es)`
                 : 'never reached the select');
    if (kb.reached) {
      for (const keys of [['t'], ['s'], ['ArrowDown'], ['End']]) {
        const beforeVal = await page.evaluate(() =>
          document.querySelector('select.f28-order-select').value).catch(() => null);
        for (const k of keys) { await page.keyboard.press(k); await sleep(400); }
        await sleep(900);
        const afterVal = await page.evaluate(() =>
          document.querySelector('select.f28-order-select').value).catch(() => null);
        kb.routes.push({ keys: keys.join('+'), from: beforeVal, to: afterVal,
                        changed: beforeVal !== afterVal });
        if (beforeVal !== afterVal) break;
      }
    }
    await settle('after the keyboard on the select');
    const kbRead = await RD.read(page);
    const kbWorked = kb.routes.find((r) => r.changed) || null;
    record('C7.6', 'and it can be operated with no mouse at all, and the list drew what it chose',
      !!kbWorked && kbRead.present && kbRead.wrapOrder === kbRead.controlValue &&
      kbRead.editors === 0 &&
      J(RD.orderOf(kbRead)) === J(
        kbRead.controlValue === 'original' ? enOriginal
          : kbRead.controlValue === 'title-asc' ? expectAsc : expectDesc),
      () => `routes tried ${J(kb.routes)}; ${kbWorked ? `${kbWorked.keys} changed it ` +
        `${kbWorked.from} → ${kbWorked.to}, list ${J(kbRead.wrapOrder)}` : 'no route worked'}`);
    await choose('original', 'back under the original order, for the disclosure walk');
    // A disclosure control from the keyboard: a real focus (not a scripted
    // focus() call), then Enter — the same standard the ordering control was
    // held to above.
    const ctxBtn = page.locator(
      `.references.page-linked .ls-block[blockid="${U.zebraG1}"] > .f28-ctx > .f28-ctx-open`)
      .first();
    await ctxBtn.scrollIntoViewIfNeeded({ timeout: 15000 }).catch(() => null);
    await ctxBtn.focus();
    const kbCtx = await page.evaluate(() => {
      const el = document.activeElement;
      return el ? { tag: el.tagName, id: el.id || null,
                    cls: typeof el.className === 'string' ? el.className : '' } : null;
    }).catch(() => null);
    await page.keyboard.press('Enter');
    await sleep(2400);
    const kbOpen = await disclosureState();
    const kbZebra = kbOpen.ctxById ? kbOpen.ctxById[U.zebraG1] : null;
    record('C7.7', 'a disclosure control is a button that works from the keyboard',
      !!kbCtx && kbCtx.tag === 'BUTTON' && !!kbZebra && kbZebra.open === true &&
      (kbZebra.panelText || '').includes('얼룩말 증손'),
      () => `focused <${kbCtx && kbCtx.tag}>; panel open after Enter ` +
        `${kbZebra && kbZebra.open}, 증손 inside ` +
        `${(kbZebra && kbZebra.panelText || '').includes('얼룩말 증손')}`);
    await page.keyboard.press('Enter');
    await sleep(2000);
    const kbShut = await disclosureState();
    record('C7.8', 'and Enter again closes it, leaving the row as it was found',
      !!kbShut.ctxById && kbShut.ctxById[U.zebraG1].open === false,
      `open ${kbShut.ctxById ? kbShut.ctxById[U.zebraG1].open : 'no reading'}`);

    // =====================================================================
    // C8 — the read-only interval, closed with a hash while the app is open
    // =====================================================================
    say('\nC8  everything so far was read-only; the graph, hashed now, proves it');
    phase('read-only-accounting', 'hash-the-graph-before-the-first-declared-write');
    const midway = GH.snapshot(GRAPH);
    const midCmp = GH.compare(before, midway);
    observations.midRun = {
      content: midCmp.content.map((c) => `${c.change} ${c.file}`),
      housekeeping: midCmp.housekeeping.map((c) => `${c.change} ${c.file}`),
    };
    record('C8.1', 'the overview, the Crystal marker, the contexts, the inbound walk, the ' +
      'source navigation, both disclosures, three reorders, the language switch and the ' +
      'keyboard wrote nothing at all',
      midCmp.content.length === 0,
      midCmp.content.length ? J(midCmp.content.map((c) => `${c.change} ${c.file}`))
                            : `0 content changes across ${midCmp.afterCount} files`);
    record('C8.2', 'and the control page is byte-identical while the application is open',
      CG.readPage(GRAPH, CG.CONTROL_FILE) === controlBefore, CG.CONTROL_FILE);

    // =====================================================================
    // C9 — JOURNEY 2: the inline panel beside the list; a declared edit and
    //      the documented refresh behaviour
    // =====================================================================
    say('\nC9  journey 2: the inline panel beside the list; a declared edit, and Refresh');
    phase('inline-panel', 'open-the-panel-its-context-and-its-incoming-references');
    await openPanel(U.hostMain, 'open the inline panel on the anchor page');
    await openContext(U.hostMain, 'open its context');
    await openOutgoing(U.hostMain, 'open the outgoing section');
    await openInbound(U.hostMain, 'open its incoming references');
    const firstRead = await waitFor('the first reading of the incoming references',
      (s) => {
        const w = wrapAt(s, U.hostMain);
        return !!w && !!w.panel && w.panel.inOpen && w.panel.inTexts.length > 0;
      }, 30000);
    let w0 = wrapAt(firstRead.state, U.hostMain);
    observations.inlineFirst = w0 && w0.panel;
    record('C9.1', 'the panel\'s first disclosure names the target\'s own page in its crumb',
      !!w0 && !!w0.panel && (w0.panel.crumb || '').includes(CG.MAIN_TARGET_PAGE),
      () => `crumb ${J(w0 && w0.panel && w0.panel.crumb)}`);
    record('C9.2', 'it says in words that its lists are read rather than live, and offers ' +
      'Refresh above the content and again at its end',
      !!w0 && /Refresh/.test(w0.panel.snapshotNote || '') &&
      w0.panel.refreshControls === 2 && (w0.panel.refreshLabel || '').length > 0,
      () => `${w0 && w0.panel ? w0.panel.refreshControls : 0} control(s) named ` +
        `${J(w0 && w0.panel && w0.panel.refreshLabel)}; note ` +
        `${J((w0 && w0.panel && w0.panel.snapshotNote || '').slice(0, 120))}`);
    record('C9.3', 'the outgoing section lists what the TARGET ITSELF points at, with its ' +
      'source page in the crumb',
      !!w0 && w0.panel.outOpen && (w0.panel.outRows || []).length === 1 &&
      (w0.panel.outRows[0].label || '').includes('나가는 대상 본문') &&
      (w0.panel.outRows[0].crumb || '').includes(CG.OUTGOING_PAGE),
      () => `rows ${J(w0 && w0.panel && w0.panel.outRows)}`);
    record('C9.4', 'the incoming-reference section lists exactly the sources the fixture ' +
      'wrote, and counts them',
      firstRead.ok && !!w0 && w0.panel.inTexts.length === CG.MAIN_INBOUND.atStart &&
      w0.panel.inTexts.some((x) => x.includes('출처 하나')) &&
      w0.panel.inTexts.some((x) => x.includes('본문 패널의 호스트')),
      () => `${w0 && w0.panel ? w0.panel.inTexts.length : 0} row(s), declared ` +
        `${CG.MAIN_INBOUND.atStart}: ${J(w0 && w0.panel && w0.panel.inTexts)}`);
    const alongside = await RD.read(page);
    record('C9.5', 'and the F28 linked-references list is still there BESIDE the open panel, ' +
      'groups intact',
      alongside.present === true && alongside.groups.length === 8 && alongside.editors === 0,
      () => `${alongside.groups.length} group(s) still drawn beside the panel`);
    const panelIdFirst = w0.panel.id;

    phase('inline-panel', 'walk-one-level-then-refresh');
    const exploreBtn = page.locator(
      `#main-content-container [blockid="${U.hostMain}"] .f27-in-item .f27-in-explore`).first();
    await parkPointer();
    await exploreBtn.click({ timeout: 15000 });
    await sleep(2100);
    const walked = wrapAt(await ilState(), U.hostMain);
    observations.inlineWalk = walked && walked.panel;
    record('C9.6', 'the walk goes one level further in, and records its path',
      !!walked && walked.panel.inPath.length >= 1 &&
      (walked.panel.inTexts || []).some((x) => x.includes('두 번째 층')),
      () => `path ${J(walked && walked.panel.inPath)}; items ` +
        `${J(walked && walked.panel.inTexts)}`);
    const hashBeforeWalkRefresh = GH.snapshot(GRAPH);
    await refresh(U.hostMain, 'press Refresh, with the walk open');
    // The walk's ROOT is the ORIGIN step, and the origin is always drawn —
    // `f27-in-path` renders every step of the trail, origin first, so a fresh
    // root shows ONE step (the panel's own target), not none: C9.6's evidence
    // shows two (origin › walked). And the route hash lives on the VIEW state,
    // not on the panel — run 4 compared a field the reader never had.
    const walkReset = await waitFor('the walk back at its root',
      (s) => {
        const w = wrapAt(s, U.hostMain);
        return !!w && !!w.panel && w.panel.inOpen && w.panel.inPath.length === 1 &&
          w.panel.inTexts.length === CG.MAIN_INBOUND.atStart;
      }, 30000);
    w0 = wrapAt(walkReset.state, U.hostMain);
    observations.inlineRefresh1 = w0 && w0.panel;
    record('C9.7', 'Refresh returns the walk to its root and re-reads the same list, in place',
      walkReset.ok && !!w0 && w0.panel.id === panelIdFirst && w0.open &&
      w0.panel.ctxOpen && w0.panel.inOpen &&
      walkReset.state.hash === (firstRead.state || {}).hash,
      () => `root again ${walkReset.ok} (origin step only, ` +
        `${J(w0 && w0.panel && w0.panel.inPath)}); same panel id ` +
        `${!!w0 && w0.panel.id === panelIdFirst}; ` +
        `context ${w0 && w0.panel.ctxOpen}, section ${w0 && w0.panel.inOpen}; ` +
        `hash ${J(walkReset.state && walkReset.state.hash)}`);
    record('C9.8', 'and the refresh itself wrote nothing: the graph is unchanged around it',
      GH.compare(hashBeforeWalkRefresh, GH.snapshot(GRAPH)).content.length === 0,
      () => `0 content changes between the hash taken before the press and the hash taken after`);

    phase('declared-edit', 'add-a-source-through-ogs-own-api');
    const joinOk = await api('update_block', [U.srcJoins, T.srcJoinsAfter, null],
      'the joining source STARTS referring to the main target');
    await sleep(6000);
    const beforeRefreshJoin = wrapAt(await ilState(), U.hostMain);
    // OBSERVED, not assumed — the documented behaviour the refresh control
    // answers: the open section replays the level it read, so a source that
    // appears afterwards is not in it until the reader asks again.
    record('C9.9', 'declared edit 1 recorded, and the OPEN section still shows what it read: ' +
      'it is a snapshot, exactly as documented',
      joinOk.ok === true &&
      !!beforeRefreshJoin && beforeRefreshJoin.panel.inTexts.length === CG.MAIN_INBOUND.atStart &&
      !beforeRefreshJoin.panel.inTexts.some((x) => x.includes('이제 대상을 참조합니다')),
      () => `via logseq.api.update_block; ${beforeRefreshJoin.panel.inTexts.length} row(s) ` +
        `still, the new source ${beforeRefreshJoin.panel.inTexts
          .some((x) => x.includes('이제 대상을 참조합니다')) ? 'PRESENT (unexpected)' : 'absent (documented)'}`);
    const settledJoin = await settleGraph(5000, 90000);
    const afterEditHash = GH.snapshot(GRAPH);
    const editCmp = GH.compare(midway, afterEditHash);
    observations.firstEditWrites = editCmp.content.map((c) => `${c.change} ${c.file}`);
    record('C9.10', 'the edit wrote exactly the joining page, and nothing else',
      editCmp.content.length === 1 &&
      editCmp.content[0].file === writeAccounting.joiningFile,
      () => `${J(editCmp.content.map((c) => `${c.change} ${c.file}`))} ` +
        `(graph settled ${settledJoin.quiet ? 'quietly' : 'still changing'})`);
    await refresh(U.hostMain, 'press Refresh, with the new source in the graph');
    const joined = await waitFor('the new source after Refresh',
      (s) => {
        const w = wrapAt(s, U.hostMain);
        return !!w && !!w.panel && w.panel.inOpen &&
          w.panel.inTexts.some((x) => x.includes('이제 대상을 참조합니다'));
      }, 30000);
    w0 = wrapAt(joined.state, U.hostMain);
    observations.inlineRefresh2 = w0 && w0.panel;
    record('C9.11', 'Refresh shows the source that has just appeared, in the same panel, with ' +
      'every disclosure still open',
      joined.ok && !!w0 && w0.panel.inTexts.length === CG.MAIN_INBOUND.afterJoin &&
      w0.panel.id === panelIdFirst && w0.open && w0.panel.ctxOpen && w0.panel.inOpen,
      () => `${w0.panel.inTexts.length} row(s), declared ${CG.MAIN_INBOUND.afterJoin}: ` +
        `${J(w0.panel.inTexts)}; same panel id ${w0.panel.id === panelIdFirst}`);
    record('C9.12', 'and again the refresh itself wrote nothing beyond the edit',
      GH.compare(afterEditHash, GH.snapshot(GRAPH)).content.length === 0,
      '0 content changes between the hashes taken either side of the press');

    phase('declared-edit', 'remove-the-reference-then-refresh');
    const leaveOk = await api('update_block', [U.srcJoins, T.srcJoinsRemoved, null],
      'the joining source STOPS referring to the main target');
    await sleep(6000);
    const settledLeave = await settleGraph(5000, 90000);
    await refresh(U.hostMain, 'press Refresh, with the source gone');
    const left = await waitFor('the list back at its declared size',
      (s) => {
        const w = wrapAt(s, U.hostMain);
        return !!w && !!w.panel && w.panel.inOpen &&
          w.panel.inTexts.length === CG.MAIN_INBOUND.afterLeave &&
          !w.panel.inTexts.some((x) => x.includes('출처 둘'));
      }, 30000);
    w0 = wrapAt(left.state, U.hostMain);
    observations.inlineRefresh3 = w0 && w0.panel;
    record('C9.13', 'Refresh shows the source gone again, in the same panel',
      left.ok && leaveOk.ok === true && !!w0 &&
      w0.panel.inTexts.length === CG.MAIN_INBOUND.afterLeave &&
      w0.panel.id === panelIdFirst,
      () => `${w0.panel.inTexts.length} row(s), declared ${CG.MAIN_INBOUND.afterLeave}: ` +
        `${J(w0.panel.inTexts)}`);
    const editorsNow = (await ilState()).editors;
    record('C9.14', 'no editor was opened at any point in the journey',
      editorsNow === 0, `${editorsNow} editor textarea(s) open`);

    // =====================================================================
    // C10 — JOURNEY 4: a real filter, the kept groups sorted, another page,
    //       and back — each piece of view state in its documented scope
    // =====================================================================
    say('\nC10 journey 4: a real filter, sorting on top of it, and view-state scope');
    const headingNow = () => page.evaluate(() => {
      const h = document.querySelector('.references.page-linked h2');
      return h ? (h.innerText || '').replace(/\s+/g, ' ').trim() : null;
    }).catch(() => null);
    const openFilter = async () => {
      try {
        await page.evaluate(() => {
          const a = document.querySelector('.references.page-linked a.filter');
          if (a) a.scrollIntoView({ block: 'center' });
        }).catch(() => null);
        await page.locator('.references.page-linked a.filter').first()
          .click({ timeout: 15000 });
      } catch (e) {
        say(`          (open filter: ${String(e.message).split('\n')[0]})`);
      }
      await sleep(2500);
    };
    const clickFilterButton = async (pageName, exclude, headingBefore) => {
      const diag = { clicked: false, applied: false, headingAfter: null };
      try {
        await page.locator('.ls-filters button', { hasText: pageName }).first()
          .click({ timeout: 8000, modifiers: exclude ? ['Shift'] : [] });
        diag.clicked = true;
      } catch (e) {
        diag.error = String(e.message).split('\n')[0].slice(0, 200);
      }
      for (let i = 0; i < 5 && !diag.applied; i++) {
        await sleep(1200);
        const after = await headingNow();
        diag.applied = after !== null && after !== headingBefore;
        if (diag.applied) diag.headingAfter = after;
      }
      return diag;
    };

    phase('filtering', 'apply-an-exclude-filter-with-ogs-own-gesture');
    await choose('original', 'before the filter is applied');
    const preFilter = await RD.read(page);
    await openFilter();
    const excluded = await clickFilterButton(CG.GA, true, preFilter.heading);
    await page.keyboard.press('Escape').catch(() => null);
    await settle('under the exclude filter');
    const filtered = await RD.read(page);
    observations.filterExclude = filtered.present ? RD.lean(filtered) : filtered;
    const chosenRef = CG.GROUP_IDS.ga;
    record('C10.1', 'excluding a source page really removes its group and its rows',
      excluded.applied && filtered.present &&
      !RD.orderOf(filtered).includes(chosenRef),
      () => `${excluded.applied ? 'applied' : 'did NOT apply'} the exclude of ${J(CG.GA)}; ` +
        `${filtered.groups.length} group(s) left, ${filtered.rows.length} row(s), ` +
        `heading ${J(filtered.heading)}`);
    const fAscPick = await choose('title-asc', 'the kept groups, ascending');
    const fAsc = await RD.read(page);
    record('C10.2', 'the filter chooses WHICH groups; the order then arranges what it kept',
      fAscPick.changed && fAsc.present &&
      J(RD.orderOf(fAsc)) === J(expectAsc.filter((r) => r !== chosenRef)),
      () => `drawn    ${J(RD.orderOf(fAsc))}\n          expected ` +
        `${J(expectAsc.filter((r) => r !== chosenRef))}`);
    record('C10.3', 'every row still drawn keeps its role label, and both F28 controls are ' +
      'still offered on the kept rows',
      fAsc.present && fAsc.labels === fAsc.rows.length && fAsc.rows.length > 0 &&
      fAsc.ctxControls > 0 && fAsc.pathControls > 0,
      () => `${fAsc.labels} label(s) on ${fAsc.rows.length} row(s); ` +
        `${fAsc.ctxControls} child-context, ${fAsc.pathControls} source-path control(s)`);

    phase('view-scope', 'visit-another-page-and-return');
    // Leave the anchor with the order at title-asc, deliberately: the alias
    // page's own list must open as a FRESH view — original, nothing carried
    // over — while the FILTER, being a page property, persists.
    await goTo(CG.ALIAS);
    await settle('on the alias page');
    const aliasRead = await RD.read(page);
    observations.aliasPage = aliasRead.present ? RD.lean(aliasRead) : aliasRead;
    // C10.4 premise, corrected by the fourth run's own evidence: OG's `alias`
    // query rule is BIDIRECTIONAL (deps/db rules.cljc draws `[?e2 :block/alias
    // ?e1]` and `[?e1 :block/alias ?e2]` alike), and `page-alias-set` feeds it
    // to the linked-references query — so the ALIAS page's list is the union:
    // every block naming the alias (zebra, its one DIRECT source) AND every
    // block naming the anchor (the 8 groups the anchor's own list carries),
    // plus the anchor page itself, whose `alias::` property line names the
    // alias. That is OG's own page-family semantics, not this slice's doing —
    // measured: 9 groups, the anchor's 8 plus "기준 대상 anchor page".
    const aliasAnchorRef = CG.ANCHOR.normalize('NFC').toLowerCase();
    const aliasExpected = [...new Set([...originalOrder, aliasAnchorRef])].sort();
    const aliasSet = [...RD.orderOf(aliasRead)].sort();
    record('C10.4', 'the alias page\'s own list is there — OG\'s own alias rule is ' +
      'bidirectional, so it carries its direct source AND the anchor\'s sources',
      aliasRead.present === true && J(aliasSet) === J(aliasExpected) &&
      aliasRead.groups.some((g) => g.ref === CG.GROUP_IDS.zebra),
      () => aliasRead.present ? `${aliasRead.groups.length} group(s), the anchor's ` +
        `${originalOrder.length} plus the anchor page itself; set matches OG's ` +
        `bidirectional alias rule ${J(aliasSet) === J(aliasExpected)}; zebra, the ` +
        `alias's own direct source, among them ` +
        `${aliasRead.groups.some((g) => g.ref === CG.GROUP_IDS.zebra)}` :
        'no list on the alias page');
    record('C10.5', 'and it opens as a FRESH view: original order, the anchor\'s choices left ' +
      'behind on the anchor',
      aliasRead.present && aliasRead.controlValue === 'original' &&
      aliasRead.wrapOrder === 'original',
      () => `control ${J(aliasRead.controlValue)}, list ${J(aliasRead.wrapOrder)}`);
    await goTo(CG.ANCHOR);
    await settle('back on the anchor page');
    const returned = await RD.read(page);
    observations.afterReturn = returned.present ? RD.lean(returned) : returned;
    record('C10.6', 'on return the FILTER persists — it is a page property OG wrote — and the ' +
      'ordering does not: it is a view-local choice, reset to the default',
      returned.present && !RD.orderOf(returned).includes(chosenRef) &&
      returned.controlValue === 'original' && returned.wrapOrder === 'original' &&
      returned.groups.length === filtered.groups.length,
      () => `가 still excluded: ${!RD.orderOf(returned).includes(chosenRef)}; control ` +
        `${J(returned.controlValue)}, list ${J(returned.wrapOrder)}; ` +
        `${returned.groups.length} group(s) as under the filter`);
    const liveState = await page.evaluate((display) => {
      const out = { filters: null, error: null };
      try {
        const apiNs = window.logseq && window.logseq.api;
        const p = apiNs && typeof apiNs.get_page === 'function'
          ? apiNs.get_page(display) : null;
        out.filters = p && p.properties ? p.properties.filters : null;
      } catch (e) { out.error = String(e && e.message); }
      return out;
    }, CG.ANCHOR).catch((e) => ({ filters: null, error: String(e.message) }));
    observations.filterLiveState = liveState;
    record('C10.7', 'the application reports the exclude as the anchor page\'s own property',
      liveState.filters !== null && liveState.filters !== undefined &&
      J(liveState.filters).toLowerCase().includes(CG.GA.toLowerCase()),
      () => `get_page(...).properties.filters = ${J(liveState.filters)}` +
        (liveState.error ? ` (error: ${liveState.error})` : ''));

    // =====================================================================
    // C11 — JOURNEY 5b: the excluded surface, measured live
    // =====================================================================
    say('\nC11 journey 5b: the right sidebar carries none of it');
    phase('sidebar-exclusion', 'open-the-anchor-in-the-right-sidebar');
    await goTo(CG.NA);
    await sleep(2500);
    await parkPointer();
    let opened = { found: false };
    try {
      await page.locator(`#main-content-container a.page-ref:text-is("${CG.ANCHOR}")`)
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
      selects: document.querySelectorAll('.sidebar-item .f28-order-select').length,
      orderAttrs: document.querySelectorAll('.sidebar-item [data-f28-order]').length,
      ctxControls: document.querySelectorAll('.sidebar-item .f28-ctx-open').length,
      pathControls: document.querySelectorAll('.sidebar-item .f28-path-toggle').length,
      roleLabels: document.querySelectorAll('.sidebar-item .f28-role').length,
      inlineWrappers: document.querySelectorAll('.sidebar-item .f27-il').length,
      overviews: document.querySelectorAll('.sidebar-item .f27-ref-overview').length,
    })).catch(() => null);
    observations.sidebar = sidebar;
    record('C11.1', 'a linked-references list really is rendered in the right sidebar',
      !!sidebar && sidebar.items > 0 && sidebar.rows > 0,
      () => `${J(sidebar)} (shift-click found a link: ${opened.found})`);
    record('C11.2', 'and it carries NONE of the reference workflow: no ordering, no disclosure, ' +
      'no role labels, no inline panels',
      !!sidebar && sidebar.rows > 0 && sidebar.selects === 0 &&
      sidebar.orderAttrs === 0 && sidebar.ctxControls === 0 &&
      sidebar.pathControls === 0 && sidebar.roleLabels === 0 &&
      sidebar.inlineWrappers === 0 && sidebar.overviews === 0,
      () => sidebar ? `${sidebar.rows} row(s) with ${sidebar.selects} select(s), ` +
        `${sidebar.ctxControls} child-context, ${sidebar.pathControls} source-path, ` +
        `${sidebar.roleLabels} role label(s), ${sidebar.inlineWrappers} inline wrapper(s)` : 'no reading');
  } finally {
    errorEvidence = await session.collectErrorEvidence();
    await APP.close(session, { say });
  }

  // ---------- C12 : the graph after close, and the accounting ----------
  say('\nC12 the graph after the application has closed');
  const after = GH.snapshot(GRAPH);
  const cmp = GH.compare(before, after);
  const declaredFiles = [writeAccounting.anchorFile, writeAccounting.joiningFile];
  const declared = cmp.content.filter((c) => declaredFiles.includes(c.file));
  const otherContent = cmp.content.filter((c) => !declaredFiles.includes(c.file));
  record('C12.1', 'nothing changed except the two writes this run declared in advance',
    otherContent.length === 0 && declared.length === 2 &&
    declared.every((c) => c.change === 'modified'),
    otherContent.length ? J(otherContent.map((c) => `${c.change} ${c.file}`))
                        : `${declared.length} declared write(s): ` +
                          `${J(declared.map((c) => c.file))}; 0 other content changes across ` +
                          `${cmp.afterCount} files`);
  record('C12.2', 'OG housekeeping is recorded separately rather than counted as content', true,
    cmp.housekeeping.length ? `${cmp.housekeeping.length}: ` +
      cmp.housekeeping.map((c) => `${c.change} ${c.file}`).slice(0, 6).join('; ') : 'none');

  // The anchor: exactly the `filters::` line OG's own save-filter wrote.
  const anchorAfter = CG.readPage(GRAPH, writeAccounting.anchorFile);
  const anchorBeforeLines = (writeAccounting.anchorBefore || '').split('\n');
  const anchorAfterLines = anchorAfter.split('\n');
  const anchorAdded = anchorAfterLines.filter((l) => !anchorBeforeLines.includes(l));
  const anchorGone = anchorBeforeLines.filter((l) => !anchorAfterLines.includes(l));
  observations.anchorWrite = { added: anchorAdded, gone: anchorGone };
  record('C12.3', 'the anchor write is exactly `filters::` line(s), and nothing the page said ' +
    'before was lost',
    declared.some((c) => c.file === writeAccounting.anchorFile) &&
    anchorAdded.length >= 1 && anchorAdded.every((l) => l.includes('filters::')) &&
    anchorGone.every((l) => anchorAfterLines.some((a) => a.trim() === l.trim())),
    () => `added ${J(anchorAdded)}, removed ${J(anchorGone)}`);

  // The joining page: the end state as CONTENT FACTS, because the application
  // wrote it, not this fixture.
  const joiningAfter = CG.readPage(GRAPH, writeAccounting.joiningFile);
  const end = CG.EXPECTED_END[writeAccounting.joiningFile.replace(/^pages\//, '')];
  const missing = end.present.filter((s) => !joiningAfter.includes(s));
  const stillThere = end.absent.filter((s) => joiningAfter.includes(s));
  const leftBehind = end.absentAfterBeingAdded.filter((s) => joiningAfter.includes(s));
  observations.joiningWrite = { missing, stillThere, leftBehind };
  record('C12.4', 'the joining page ends as declared: the reference added and then removed, ' +
    'the original text gone, the kept sources intact',
    declared.some((c) => c.file === writeAccounting.joiningFile) &&
    missing.length === 0 && stillThere.length === 0 && leftBehind.length === 0,
    () => `missing ${J(missing)}, should-be-gone-but-present ${J(stillThere)}, ` +
      `added-and-never-removed ${J(leftBehind)}`);
  record('C12.5', 'the control page is byte-identical after the whole session',
    CG.readPage(GRAPH, CG.CONTROL_FILE) === controlBefore, CG.CONTROL_FILE);

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
    expected: cls.expected.map((e) => ({ seq: e.seq, phase: e.phase, reason: e.reason, text: e.text })),
    browserNoise: split.noise.map((e) => ({ seq: e.seq, text: e.text,
                                            pairedWithSeq: e.pairedWithSeq === undefined
                                              ? null : e.pairedWithSeq })),
    refusedByRule: split.refused.map((e) => ({ seq: e.seq, text: e.text,
                                               refusedBecause: e.refusedBecause })),
    unexpected: split.remaining.map((e) => ({ seq: e.seq, phase: e.phase, text: e.text })),
    ruleAccounting: split.evidence,
  };
  observations.applied = applied;
  const inFeature = split.remaining.filter((e) => FEATURE_PHASES.includes(e.phase));
  record('C12.6', 'no window error arrived in any phase that operated this workflow',
    inFeature.length === 0,
    () => `${inFeature.length} in the feature phases; ${split.remaining.length} unexplained ` +
      `in total${split.remaining.length ? ` (${split.remaining.map((e) => e.phase).join(', ')})` : ''}`);
  record('C12.7', 'every window error was entitled; ONLY the exact browser notice is ever ' +
    'exempted — a refused `[frontend.handler]` line FAILS this check, as the rule requires',
    split.remaining.length === 0,
    () => `${errors.entries().length} captured across ${J(cls.byPhase)}; ` +
      `${cls.expected.length} expected, ${split.noise.length} exempted, ` +
      `${split.refused.length} handler line(s) refused by the rule, ` +
      `${split.remaining.length} unexplained` +
      (split.remaining.length ? `: ${EC.describe(split.remaining, 1)[0]}` : ''));

  const leftovers = ownedTree.filter(OP.alive);
  record('C12.8', 'every process this run owned has exited', leftovers.length === 0,
    leftovers.length ? J(leftovers)
                     : `${ownedTree.length} process(es) owned at launch, none still alive`);

  const pass = results.filter((r) => r.ok).length;
  const out = path.join(EVIDENCE, `f28-combined-workflow-${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify({ results, observations, graph: GRAPH }, null, 2));
  fs.writeFileSync(path.join(EVIDENCE, 'f28-combined-workflow-summary.json'),
    JSON.stringify({ results: results.map((r) => ({ id: r.id, ok: r.ok, title: r.title })),
                     build: observations.build, graph: GRAPH,
                     passed: pass, total: results.length }, null, 2));
  say(`\n  ${pass}/${results.length} checks passed`);
  say(`  evidence: ${out}\n`);
  if (pass !== results.length) process.exitCode = 1;
}

main().catch((e) => { say(`\nFAILED: ${e.stack || e.message}\n`); process.exitCode = 1; });