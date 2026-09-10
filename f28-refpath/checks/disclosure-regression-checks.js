#!/usr/bin/env node
'use strict';
//
// THE CORRECTION BATCH'S ONE TARGETED PACKAGED CHECK — focused regressions on
// the two modified disclosure components, and fresh ordered evidence for the
// corrected identity-scoped comparator.
//
//   node f28-refpath/checks/disclosure-regression-checks.js
//
// The supervisor review (2026-09-10) set this batch's packaged scope, and this
// file is exactly that scope and nothing more:
//
//   * the two components `d6a282678` gave `rum/reactive` to — `f28-source-path`
//     and `f28-child-context` — against the CURRENT package, the one the
//     accepted combined run used: language switching WITH BOTH PANELS OPEN (the
//     reactiveness fix's own failure class, live on the same view), preserved
//     panel state/identity across the reorders, and keyboard operation;
//   * fresh ordered readings for the three comparisons the retained run-5
//     evidence could NOT re-evaluate (see checks/retrospective-comparator.js):
//     the C5.14 pair (its second reading was overwritten by the post-filter
//     return), C6.13's finalRead and C7.4's koRead were never retained. This
//     run takes its own first reading, reorders under open panels, switches
//     the language with the panels still open, and re-enters the page, and
//     compares every pair with the CORRECTED comparator —
//     checks/inside-containers.js: container order across containers
//     tolerated (OG's documented `(group-by :block/parent)` nondeterminism),
//     within-container row order, parentage, membership, roles, levels,
//     breadcrumb paths and duplicate occurrences compared exactly.
//
// This is NOT acceptance of the combined scenario (that stands on run 5's own
// evidence), NOT a rerun of any role/order scenario, and NOT the full OG
// baseline. It asks OG for NO WRITE AT ALL: the whole session is read-only,
// and the graph is hashed before launch and after close to prove it.
//
// THE UNRESOLVED `[frontend.handler]` CONDITION STANDS: the browser-noise rule
// refuses a handler line this harness cannot pair with Chromium's exact
// ResizeObserver notice, and if one appears the error check FAILS. No
// exemption is widened and nothing is rerun to make a number go up.
//
// MANDATORY GRAPH-DATA BOUNDARY (project-notes/DATA_ACCESS_GUARDRAIL.md): only
// this run's own fresh synthetic graph inside ~/Library/Mobile Documents/
// com~apple~CloudDocs/Logseq Test, the loaded path asserted LIVE from OG's own
// state before any feature interaction, no personal graph touched, no earlier
// run's folder reused, the installed application never launched.
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

// Every phase in which one of THIS RUN's features was the thing on screen.
const FEATURE_PHASES = ['first-reading', 'panels-open', 'reorder', 'language',
                       'keyboard', 're-entry'];

async function main() {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  say('\n=== Disclosure regressions + the corrected comparator, in one read-only session ===\n');

  // ---------- R0 : the package ----------
  say('R0  the current package, identified before anything else');
  const built = APP.resolve(FEATURE_APP);
  const v = built.preflight;
  record('R0.1', 'this build is present and passes its identity check', v.ok,
    v.ok ? `${built.appName}: build ${v.manifest.pilotBuildId}, renderer ` +
           `${v.manifest.builtFrom.rendererRevision}, branch ${v.manifest.builtFrom.branch}, ` +
           `dirty ${v.manifest.dirty ? 'true' : 'false'}`
         : `${v.reason}: ${v.detail}`);
  if (!v.ok) throw new Error('preflight failed');
  observations.build = {
    app: built.appName, branch: v.manifest.builtFrom.branch,
    commit: v.manifest.builtFrom.commit, dirty: v.manifest.builtFrom.dirty,
    renderer: v.manifest.builtFrom.rendererRevision, buildId: v.manifest.pilotBuildId,
  };
  const runtime = path.join(built.resApp, 'js', 'cljs-runtime');
  const names = fs.existsSync(runtime) ? fs.readdirSync(runtime) : [];
  const carries = (p) => names.some((n) => n.startsWith(p));
  record('R0.2', 'the packaged renderer carries the two components this run regresses, ' +
    'and the ordering control that moves the groups under them',
    carries('frontend.util.f28_refpath') && carries('frontend.util.f28_refctx') &&
    carries('frontend.util.f28_reforder'),
    `path ${carries('frontend.util.f28_refpath')}, ctx ${carries('frontend.util.f28_refctx')}, ` +
    `order ${carries('frontend.util.f28_reforder')}`);

  // ---------- R1 : a fresh graph, hashed, with NOTHING declared ----------
  say('\nR1  a fresh synthetic graph; this run asks OG for no write at all');
  const g = CG.build({ kind: 'workflow' });
  const GRAPH = B.assertInsideAllowedRoot('disclosure-regression graph', g.graph);
  record('R1.1', 'created fresh inside the permitted root; no earlier run reused or touched',
    true, `${GRAPH} (${g.pages} pages + ${g.journal})`);
  const before = GH.snapshot(GRAPH);
  const controlBefore = CG.readPage(GRAPH, CG.CONTROL_FILE);
  record('R1.2', 'every file hashed before the application is launched',
    Object.keys(before).length >= g.pages + 2, `${Object.keys(before).length} files`);
  record('R1.3', 'no declared write exists for this run — the whole session is read-only ' +
    'and will be proved so by the hash after close',
    true, 'no update_block, no filter, no edit: every comparison below is a reading');
  const BAD = path.join(path.dirname(B.allowedRootReal()), 'f28-disclosure-inert-probe');
  record('R1.4', 'the bad-dialog probe path is outside the permitted root and inert',
    !B.isInsideAllowedRoot(BAD) && !fs.existsSync(BAD), BAD);

  // ---------- R2/R3 : launch, refuse, open (recorded by the launcher) ----------
  const session = await APP.open({
    built, graph: GRAPH, bad: BAD, errors, say, record, phase, prefix: 'R',
  });
  const { page, goTo, parkPointer } = session;
  ownedTree = session.ownedTree;

  try {
    const settle = RD.makeSettle(page, session, say);
    const U = CG.UUID;
    const insideSetOf = IC.insideSetOf;
    const insideCompare = IC.insideCompare;

    /** Choose an order through the control, then settle. */
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

    // The two disclosures' state, in one reader (the combined scenario's own).
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
          label: open ? clean(open.innerText) : null,
          open: !!panel,
          panelId: panel ? panel.id : null,
          panelText: panel ? clean(panel.innerText).slice(0, 400) : null,
        };
      };
      const byId = {};
      for (const el of rows) byId[el.getAttribute('blockid')] = readCtx(el);
      const UUID_RE = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
      const paths = [...sec.querySelectorAll('.f28-path')]
        .filter((holder) => holder.querySelector(':scope > .breadcrumb .f28-path-toggle'))
        .map((holder) => {
        const toggle = holder.querySelector(':scope > .breadcrumb .f28-path-toggle');
        const panel = holder.querySelector(':scope > .f28-path-panel');
        const tid = (toggle && toggle.id) || '';
        const crumbId = (new RegExp(UUID_RE + '-toggle$')).test(tid)
          ? tid.match(new RegExp(UUID_RE + '-toggle$'))[1] : null;
        return {
          crumbId,
          crumb: clean((holder.querySelector(':scope > .breadcrumb') || {}).innerText),
          toggle: toggle ? {
            id: toggle.id,
            expanded: toggle.getAttribute('aria-expanded'),
            ariaLabel: clean(toggle.getAttribute('aria-label') || ''),
            label: clean(toggle.innerText),
          } : null,
          panel: panel ? {
            id: panel.id,
            steps: [...panel.querySelectorAll('.f28-path-step')]
              .map((li) => clean((li.querySelector('.f28-path-text') || li).innerText)),
            status: clean((panel.querySelector('.f28-path-status') || {}).innerText),
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

    // Both components' words, READ TOGETHER WITH THE STATE THEY DEPEND ON.
    //
    // The first cut of R6 asserted the CLOSED wording while R4 had deliberately
    // left both panels OPEN, and the run measured the open wording — a wrong
    // premise in the check, not a defect in the components. That same run proves
    // the state-dependence by itself: R4.2 recorded aria-label "Show the rest of
    // this path" while the control was still collapsed, and R6.1 recorded "Hide
    // the rest of this path" once R4.3 had opened it. Both of those passed.
    //
    // Each control's words arrive by a different route, and each is read here so
    // it can be asserted against what it actually is:
    //
    //   * `.f28-path-toggle` — aria-label AND title are
    //     `(if press (t :f28/path-hide) (t :f28/path-show))`: STATE-dependent;
    //   * `.f28-ctx-open` — aria-label is `(if desc (t :f28/context-hide-of named)
    //     (t :f28/context-show-of named))`: state-dependent AND parameterised
    //     with the row's own graph text; `title` is the unparameterised
    //     `(if desc (t :f28/context-hide) (t :f28/context-show))`, also
    //     state-dependent; while its INNER TEXT is `(t :f28/context-show)`
    //     unconditionally — language-dependent but state-INdependent BY DESIGN.
    //
    // Both controls are addressed BY IDENTITY — the zebra row's block id and the
    // apple crumb's own toggle id — never as "the first one in the section": the
    // open panels belong to particular rows, and a bare `querySelector` can
    // return a different, CLOSED control whose words then say nothing at all
    // about the state being asserted.
    const readLabels = (zebra, apple) => page.evaluate(({ zebra, apple }) => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const attr = (el, a) => (el ? clean(el.getAttribute(a) || '') : null);
      const sec = document.querySelector('.references.page-linked');
      const sel = document.querySelector('select.f28-order-select');
      const out = { orderLabel: sel ? sel.getAttribute('aria-label') : null,
                    ctx: null, path: null };
      if (!sec) return out;
      const row = sec.querySelector('.ls-block[blockid="' + zebra + '"]');
      const ctxHolder = row ? row.querySelector(':scope > .f28-ctx') : null;
      const ctxBtn = ctxHolder ? ctxHolder.querySelector(':scope > .f28-ctx-open') : null;
      if (ctxBtn) out.ctx = {
        text: clean(ctxBtn.innerText),
        aria: attr(ctxBtn, 'aria-label'),
        title: attr(ctxBtn, 'title'),
        expanded: attr(ctxBtn, 'aria-expanded'),
        open: !!ctxHolder.querySelector(':scope > .f28-ctx-panel'),
      };
      const UUID_RE = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
      for (const holder of sec.querySelectorAll('.f28-path')) {
        const toggle = holder.querySelector(':scope > .breadcrumb .f28-path-toggle');
        const m = ((toggle && toggle.id) || '').match(new RegExp(UUID_RE + '-toggle$'));
        if (!m || m[1] !== apple) continue;
        out.path = {
          aria: attr(toggle, 'aria-label'),
          title: attr(toggle, 'title'),
          expanded: attr(toggle, 'aria-expanded'),
          open: !!holder.querySelector(':scope > .f28-path-panel'),
        };
        break;
      }
      return out;
    }, { zebra, apple }).catch(() => null);
    const labelsNow = () => readLabels(U.zebraG1, U.appleRef);

    // The two dictionaries' OWN strings for these keys, mirrored here so the
    // expectation is a literal comparison against what
    // `src/resources/dicts/{en,ko}.edn` actually say (en 434-435 / 455-458,
    // ko 489-490 / 510-513) rather than a regex loose enough to pass on the
    // wrong state — which is precisely how the first cut's R6.1 passed while
    // describing a state the view was not in.
    const WORDS = {
      en: { pathShow: 'Show the rest of this path',
            pathHide: 'Hide the rest of this path',
            ctxShow: 'Show what is under this',
            ctxHide: 'Hide what is under this',
            ctxOf: { shut: /^Show what is written under "(.+)"$/,
                     open: /^Hide what is written under "(.+)"$/ } },
      ko: { pathShow: '이 경로의 나머지 보기',
            pathHide: '이 경로의 나머지 숨기기',
            ctxShow: '이 아래 내용 보기',
            ctxHide: '이 아래 내용 숨기기',
            ctxOf: { shut: /^"(.+)" 아래에 적힌 내용 보기$/,
                     open: /^"(.+)" 아래에 적힌 내용 숨기기$/ } },
    };
    // Judge one reading against the language it should now be in, using the
    // state THAT SAME READING measured. Returns the row name the parameterised
    // label carried — so the caller can hold it constant across the switch —
    // and a `why` naming the state every word was judged against, so a failure
    // here can never again be misread as "the words did not follow the
    // language" when it was the assumed state that was wrong.
    const judgeLabels = (l, lang) => {
      if (!l || !l.ctx || !l.path) {
        return { ok: false, name: null,
                 why: `a control was not found (ctx ${!!(l && l.ctx)}, ` +
                      `path ${!!(l && l.path)})` };
      }
      const w = WORDS[lang];
      const wantPath = l.path.open ? w.pathHide : w.pathShow;
      const pathOk = l.path.aria === wantPath && l.path.title === wantPath &&
        l.path.expanded === (l.path.open ? 'true' : 'false');
      const wantCtxTitle = l.ctx.open ? w.ctxHide : w.ctxShow;
      const m = (l.ctx.aria || '').match(l.ctx.open ? w.ctxOf.open : w.ctxOf.shut);
      const ctxOk = !!m && l.ctx.title === wantCtxTitle && l.ctx.text === w.ctxShow &&
        l.ctx.expanded === (l.ctx.open ? 'true' : 'false');
      return {
        ok: pathOk && ctxOk,
        name: m ? m[1] : null,
        why: `[${lang}] path ${l.path.open ? 'OPEN' : 'closed'} wants ${J(wantPath)}, has ` +
          `aria ${J(l.path.aria)} title ${J(l.path.title)} expanded ${J(l.path.expanded)} ` +
          `-> ${pathOk}; ctx ${l.ctx.open ? 'OPEN' : 'closed'} aria ${J(l.ctx.aria)} ` +
          `matches-template ${!!m}, title ${J(l.ctx.title)} wants ${J(wantCtxTitle)}, ` +
          `inner text ${J(l.ctx.text)} wants ${J(w.ctxShow)} (state-independent by ` +
          `design), expanded ${J(l.ctx.expanded)} -> ${ctxOk}`,
      };
    };

    const setLanguage = (lang) => page.evaluate((l) => {
      const st = window.frontend && window.frontend.state;
      const fn = st && st.set_preferred_language_BANG_;
      if (typeof fn !== 'function') return { ok: false, reason: 'no language seam' };
      fn(l);
      return { ok: true };
    }, lang).catch((e) => ({ ok: false, reason: String(e.message) }));

    // =====================================================================
    // R4 — the anchor page, the first reading, and both panels open
    // =====================================================================
    say('\nR4  the anchor page, the first reading, both panels open');
    phase('first-reading', 'read-the-list-before-anything-touches-it');
    await goTo(CG.ANCHOR);
    await settle('anchor page, first reading');
    const original = await RD.read(page);
    observations.original = RD.lean(original);
    const originalInside = insideSetOf(original);
    const originalOrder = RD.orderOf(original);
    const multiParent = (original.groups || []).filter((x) => (x.crumbs || []).length > 1);
    record('R4.1', 'the list is present with its multi-parent groups — the readings the ' +
      'comparator compares are the real shaped ones',
      original.present === true && (original.groups || []).length >= 6 && multiParent.length >= 2,
      () => `${(original.groups || []).length} group(s), ${multiParent.length} multi-parent ` +
        `group(s) (${J(multiParent.map((x) => x.ref))})`);

    phase('panels-open', 'open-the-source-path-and-child-context-panels');
    const disclose = await disclosureState();
    const applePath = disclose.paths
      ? disclose.paths.find((p) => p.crumbId === U.appleRef) : null;
    record('R4.2', 'OG\'s breadcrumb still elides the apple chain, and the source-path ' +
      'control sits exactly there, collapsed',
      !!applePath && applePath.toggle && applePath.crumb.includes('⋯') &&
      applePath.toggle.expanded === 'false',
      () => `crumb ${J(applePath && applePath.crumb)}, aria-label ` +
        `${J(applePath && applePath.toggle && applePath.toggle.ariaLabel)}`);
    if (applePath && applePath.toggle) {
      await parkPointer();
      await page.locator(`.f28-path-toggle[id="${applePath.toggle.id}"]`).first()
        .click({ timeout: 15000 });
    }
    await sleep(2200);
    const pathOpen = await disclosureState();
    const applePathOpen = pathOpen.paths.find((p) => p.crumbId === U.appleRef);
    observations.pathPanel = applePathOpen && applePathOpen.panel;
    record('R4.3', 'the path panel discloses exactly the levels the crumb cut, and says the ' +
      'whole path is shown',
      !!applePathOpen && !!applePathOpen.panel &&
      applePathOpen.panel.steps.length === 2 &&
      applePathOpen.panel.steps[0].includes('사과 조상 1') &&
      applePathOpen.panel.steps[1].includes('사과 조상 2') &&
      /whole path/i.test(applePathOpen.panel.status),
      () => `${applePathOpen.panel.steps.length} step(s) ${J(applePathOpen.panel.steps)}; ` +
        `status ${J(applePathOpen.panel.status)}`);
    const zebraCtxClosed = pathOpen.ctxById ? pathOpen.ctxById[U.zebraG1] : null;
    if (zebraCtxClosed && zebraCtxClosed.control) {
      await page.evaluate((uuid) => {
        const el = document.querySelector(
          `.references.page-linked .ls-block[blockid="${uuid}"] .f28-ctx-open`);
        if (el) el.scrollIntoView({ block: 'center' });
      }, U.zebraG1).catch(() => null);
      await page.locator(
        `.references.page-linked .ls-block[blockid="${U.zebraG1}"] > .f28-ctx > .f28-ctx-open`)
        .first().click({ timeout: 15000 });
    }
    await sleep(2400);
    const both = await disclosureState();
    const zebraCtxOpen = both.ctxById ? both.ctxById[U.zebraG1] : null;
    observations.ctxPanel = zebraCtxOpen;
    record('R4.4', 'the child-context panel shows the grandchild OG was holding back, and ' +
      'both panels are open at once',
      !!zebraCtxOpen && zebraCtxOpen.open &&
      (zebraCtxOpen.panelText || '').includes('얼룩말 증손') &&
      both.pathPanels === 1 && both.ctxPanels === 1,
      () => `ctx open ${zebraCtxOpen && zebraCtxOpen.open} (panel id ` +
        `${J(zebraCtxOpen && zebraCtxOpen.panelId)}); ${both.pathPanels} path panel(s), ` +
        `${both.ctxPanels} ctx panel(s)`);
    // What the two open panels are — the identity every later step holds them to.
    const beforeCtxPanelId = zebraCtxOpen && zebraCtxOpen.panelId;
    const beforePathPanelId = applePathOpen && applePathOpen.panel
      ? applePathOpen.panel.id : null;
    const beforePathSteps = applePathOpen && applePathOpen.panel
      ? applePathOpen.panel.steps.slice() : null;

    /** Both panels open, still their own block's, same content. */
    const panelsHold = async () => {
      const d = await disclosureState();
      const zc = d.ctxById ? d.ctxById[U.zebraG1] : null;
      const ap = d.paths ? d.paths.find((p) => p.crumbId === U.appleRef) : null;
      return { d, ok: !!zc && zc.open && !!ap && !!ap.panel &&
        zc.panelId === beforeCtxPanelId &&
        ap.panel.id === beforePathPanelId &&
        beforePathSteps !== null && J(ap.panel.steps) === J(beforePathSteps) &&
        (zc.panelText || '').includes('얼룩말 증손'),
        detail: () => `ctx panel ${zc && zc.open} (id ${zc && zc.panelId}); path panel ` +
          `${ap && ap.panel ? ap.panel.id : 'none'} with ` +
          `${ap && ap.panel ? ap.panel.steps.length : 0} step(s); 증손 inside ` +
          `${(zc && zc.panelText || '').includes('얼룩말 증손')}` };
    };

    // =====================================================================
    // R5 — the reorders, under the open panels, with the corrected comparator
    // =====================================================================
    say('\nR5  the groups reordered under the open panels — the corrected comparator\'s ' +
      'fresh C6.13');
    phase('reorder', 'title-asc-title-desc-and-back-under-open-panels');
    const live = original.groups.map((x) => ({ ref: x.ref, title: x.title }));
    const expectAsc = CG.orderTitles(live, 'title-asc').map((x) => x.ref);
    const expectDesc = CG.orderTitles(live, 'title-desc').map((x) => x.ref);
    observations.expected = { ascending: expectAsc, descending: expectDesc };
    const reorderStep = async (tag, value, expected, label) => {
      const pick = await choose(value, `under ${label}, panels open`);
      const hold = await panelsHold();
      const r = await RD.read(page);
      record(tag, `${label}: both panels still open, still their own block\'s, same content, ` +
        `and the groups drew the order the control chose`,
        pick.changed && hold.ok && J(RD.orderOf(r)) === J(expected),
        () => `applied ${pick.changed}; ${hold.detail()}; groups now ${J(RD.orderOf(r))}`);
      return r;
    };
    await reorderStep('R5.1', 'title-asc', expectAsc, 'title-ascending');
    await reorderStep('R5.2', 'title-desc', expectDesc, 'title-descending');
    const backRead = await reorderStep('R5.3', 'original', originalOrder,
      'the original order again');
    // THE corrected comparison, fresh: the whole reorder cycle against the
    // first reading. Identity-scoped containers: only the order of whole
    // containers across each other is tolerated; the rows INSIDE each
    // container must keep their order, parentage, membership, roles, levels
    // and breadcrumb paths, and duplicate occurrences are counted.
    const finalInside = insideSetOf(backRead);
    const reorderDiffs = insideCompare(originalInside, finalInside);
    observations.insideScopes = {
      r5_reorder: { base: originalInside, after: finalInside, diffs: reorderDiffs },
    };
    record('R5.4', 'and inside every group nothing moved across the whole cycle — same rows ' +
      'in the same order, same nesting, same breadcrumbs',
      reorderDiffs.length === 0,
      () => reorderDiffs.length ? `differs: ${reorderDiffs.join('; ')}` :
        `${Object.keys(originalInside).length} group(s) compared as identity-scoped ` +
        `container multisets — within-container row order, parentage, membership, ` +
        `role, level and breadcrumb path exact, duplicates retained; only whole-container ` +
        `order tolerated (OG's documented per-render nondeterminism) — 0 differences`);

    // =====================================================================
    // R6 — the language, with BOTH PANELS STILL OPEN — the reactiveness fix
    // =====================================================================
    say('\nR6  Korean and English with both panels open — the reactiveness regression');
    phase('language', 'switch-the-language-with-both-panels-open');
    // The starting state is READ, never assumed: R4 opened both panels on
    // purpose and R5 held them open across the whole reorder cycle, so both
    // controls must now offer HIDE. This is the assertion the first cut had
    // backwards, and the one that now pins the state the rest of R6 is judged
    // against.
    const labelsEn = await labelsNow();
    const judgeEn = judgeLabels(labelsEn, 'en');
    record('R6.1', 'before the switch both components carry the ENGLISH words FOR THE STATE ' +
      'THEY ARE ACTUALLY IN — R4 left both panels open, so both offer Hide',
      judgeEn.ok && labelsEn.path.open === true && labelsEn.ctx.open === true,
      () => `${judgeEn.why}; the ctx row names ${J(judgeEn.name)}`);
    const switched = await setLanguage('ko');
    await sleep(3500);
    await settle('in Korean, panels open');
    const labelsKo = await labelsNow();
    const judgeKo = judgeLabels(labelsKo, 'ko');
    // THE regression `d6a282678` fixed: `t` reads the language through
    // `state/sub`, which degrades to a plain deref outside a reactive
    // component — both components now carry `rum/reactive`, so their words
    // follow the language LIVE, on this view, with their panels open. What the
    // fix has to hold is that EVERY translated channel follows: the path
    // toggle's aria-label and title, the ctx control's parameterised
    // aria-label, its unparameterised title, and its inner text — each in the
    // wording for the state the panel is actually in, which is still open.
    record('R6.2', 'after the switch BOTH components\' words are the KOREAN words for the ' +
      'SAME state — live on the same view, panels still open: the reactiveness fix holds',
      switched.ok === true && judgeKo.ok &&
      labelsKo.path.open === true && labelsKo.ctx.open === true &&
      judgeKo.name !== null && judgeKo.name === judgeEn.name,
      () => `${judgeKo.why}; order select ${J(labelsKo && labelsKo.orderLabel)}; the row's ` +
        `own name is graph content and is unchanged by the language ` +
        `(${J(judgeEn.name)} -> ${J(judgeKo.name)})`);
    const holdKo = await panelsHold();
    record('R6.3', 'the language switch moved no panel: both still open, still their own ' +
      'block\'s, same content',
      holdKo.ok, () => holdKo.detail());
    const koRead = await RD.read(page);
    const koInside = insideSetOf(koRead);
    const koDiffs = insideCompare(finalInside, koInside);
    observations.insideScopes.r6_language = { base: finalInside, after: koInside,
                                             diffs: koDiffs };
    record('R6.4', 'the language reordered nothing — the rule is not a locale — under the ' +
      'corrected comparator: same sequence on this view, same containers, same ' +
      'within-container order',
      koRead.present && J(RD.orderOf(koRead)) === J(RD.orderOf(backRead)) &&
      koDiffs.length === 0,
      () => `sequence ${J(RD.orderOf(koRead))} against ${J(RD.orderOf(backRead))}; ` +
        `${Object.keys(finalInside).length} group(s) compared as identity-scoped container ` +
        `multisets: ${koDiffs.length} difference(s)` +
        `${koDiffs.length ? ` — ${koDiffs.join('; ')}` : ''}`);
    record('R6.5', 'and the graph\'s own Korean still reads correctly in the list',
      koRead.groups.every((x) => !/�/.test(x.title)) &&
      koRead.groups.some((x) => /[가-힣]/.test(x.title)),
      `${koRead.groups.filter((x) => /[가-힣]/.test(x.title)).length} Korean title(s), 0 mojibake`);
    const backEn = await setLanguage('en');
    await sleep(3000);
    await settle('back in English, panels open');
    const labelsEn2 = await labelsNow();
    const judgeEn2 = judgeLabels(labelsEn2, 'en');
    const holdEn = await panelsHold();
    record('R6.6', 'and back in English both components\' words follow again — still the words ' +
      'for the state the panels are in, live in BOTH directions',
      backEn.ok === true && judgeEn2.ok && holdEn.ok &&
      labelsEn2.path.open === true && labelsEn2.ctx.open === true &&
      judgeEn2.name === judgeEn.name,
      () => `${judgeEn2.why}; the row name is held across both switches ` +
        `(${J(judgeEn2.name)}); ${holdEn.detail()}`);

    // =====================================================================
    // R7 — the keyboard: the ordering control and a disclosure
    // =====================================================================
    say('\nR7  the keyboard alone: the ordering control and a disclosure');
    phase('keyboard', 'operate-the-ordering-and-a-disclosure-from-the-keyboard');
    const enRead = await RD.read(page);
    const enOriginal = RD.orderOf(enRead);
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
    record('R7.1', 'the ordering control is reachable with the keyboard alone',
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
    record('R7.2', 'and it can be operated with no mouse at all, and the list drew what it chose',
      !!kbWorked && kbRead.present && kbRead.wrapOrder === kbRead.controlValue &&
      J(RD.orderOf(kbRead)) === J(
        kbRead.controlValue === 'original' ? enOriginal
          : kbRead.controlValue === 'title-asc' ? expectAsc : expectDesc),
      () => `routes tried ${J(kb.routes)}; ${kbWorked ? `${kbWorked.keys} changed it ` +
        `${kbWorked.from} → ${kbWorked.to}, list ${J(kbRead.wrapOrder)}` : 'no route worked'}`);
    await choose('original', 'back under the original order for the disclosure walk');
    const ctxBtn = page.locator(
      `.references.page-linked .ls-block[blockid="${U.zebraG1}"] > .f28-ctx > .f28-ctx-open`)
      .first();
    await ctxBtn.scrollIntoViewIfNeeded({ timeout: 15000 }).catch(() => null);
    await ctxBtn.focus();
    const kbCtx = await page.evaluate(() => {
      const el = document.activeElement;
      return el ? { tag: el.tagName, id: el.id || null } : null;
    }).catch(() => null);
    // THE STARTING STATE IS ESTABLISHED, NOT ASSUMED.
    //
    // R4.4 opened THIS row's child-context panel deliberately, and R5's
    // `panelsHold` and R6.3/R6.6's `holdEn`/`holdKo` then asserted, at every
    // step, that it stayed open — so the keyboard walk necessarily begins on an
    // OPEN panel and its first Enter is a CLOSE. The first cut asserted OPEN
    // after the first Enter and CLOSED after the second and measured the exact
    // opposite. The correction is NOT to flip those two booleans: the state is
    // read before a key is pressed, and each Enter is then asserted to TOGGLE
    // it, with aria-expanded and the panel's own content required to agree with
    // whichever state it lands in. Written this way the pair would fail just as
    // loudly if a keypress did nothing, if it moved the wrong row's panel, or
    // if the panel opened without its content.
    const zebraOf = (d) => (d && d.ctxById ? d.ctxById[U.zebraG1] : null) || null;
    const GRANDCHILD = '얼룩말 증손';
    /** Coherent = the panel, its aria-expanded and its content all say the same. */
    const coherent = (z, open) => !!z && z.open === open &&
      z.expanded === (open ? 'true' : 'false') &&
      (open ? (z.panelText || '').includes(GRANDCHILD) : z.panelText === null);
    const kbStart = zebraOf(await disclosureState());
    const startOpen = !!(kbStart && kbStart.open);
    record('R7.3', 'the disclosure the keyboard is about to operate is a real focused button, ' +
      'and its state is READ before any key is pressed — R4 opened this row\'s panel and ' +
      'every check since has held it open, so the walk starts OPEN',
      !!kbCtx && kbCtx.tag === 'BUTTON' && !!kbStart && kbStart.control === true &&
      kbCtx.id === kbStart.controlId && startOpen === true && coherent(kbStart, true),
      () => `focused <${kbCtx && kbCtx.tag}> id ${J(kbCtx && kbCtx.id)} (this row's own ` +
        `control is ${J(kbStart && kbStart.controlId)}); starting state ` +
        `${startOpen ? 'OPEN' : 'closed'}, aria-expanded ${J(kbStart && kbStart.expanded)}, ` +
        `${GRANDCHILD} inside ${(kbStart && kbStart.panelText || '').includes(GRANDCHILD)}`);
    await page.keyboard.press('Enter');
    await sleep(2400);
    const kbFirst = zebraOf(await disclosureState());
    record('R7.4', 'Enter from the keyboard alone TOGGLES it out of the state it was found in, ' +
      'on this row\'s own control, and the panel\'s content follows the state it lands in',
      coherent(kbFirst, !startOpen) && !!kbFirst &&
      kbFirst.controlId === (kbStart && kbStart.controlId),
      () => `${startOpen ? 'OPEN' : 'closed'} -> ${kbFirst && kbFirst.open ? 'OPEN' : 'closed'}` +
        ` (wanted ${!startOpen ? 'OPEN' : 'closed'}), aria-expanded ` +
        `${J(kbFirst && kbFirst.expanded)}, panel ` +
        `${kbFirst && kbFirst.panelText === null ? 'absent, as a closed control renders none'
          : `present, ${GRANDCHILD} inside ` +
            `${(kbFirst && kbFirst.panelText || '').includes(GRANDCHILD)}`}` +
        `; same control ${!!kbFirst && kbFirst.controlId === (kbStart && kbStart.controlId)}`);
    await page.keyboard.press('Enter');
    await sleep(2400);
    const kbSecond = zebraOf(await disclosureState());
    record('R7.5', 'and Enter again toggles it BACK, leaving the row exactly as the keyboard ' +
      'found it — both transitions asserted against a measured start, neither assumed',
      coherent(kbSecond, startOpen) && !!kbSecond &&
      kbSecond.controlId === (kbStart && kbStart.controlId),
      () => `${kbFirst && kbFirst.open ? 'OPEN' : 'closed'} -> ` +
        `${kbSecond && kbSecond.open ? 'OPEN' : 'closed'} (wanted the starting ` +
        `${startOpen ? 'OPEN' : 'closed'}), aria-expanded ${J(kbSecond && kbSecond.expanded)}, ` +
        `${GRANDCHILD} inside ` +
        `${(kbSecond && kbSecond.panelText || '').includes(GRANDCHILD)}`);

    // =====================================================================
    // R8 — re-entry: away and back, the corrected comparator's fresh C5.14
    // =====================================================================
    say('\nR8  away and back — the corrected comparator\'s fresh C5.14');
    phase('re-entry', 'visit-the-alias-page-and-return');
    await goTo(CG.ALIAS);
    await settle('on the alias page');
    const aliasRead = await RD.read(page);
    await goTo(CG.ANCHOR);
    await settle('back on the anchor page');
    const afterReturn = await RD.read(page);
    observations.afterReturn = RD.lean(afterReturn);
    observations.aliasPresent = aliasRead.present;
    const returnInside = insideSetOf(afterReturn);
    const returnDiffs = insideCompare(originalInside, returnInside);
    observations.insideScopes.r8_reentry = { base: originalInside, after: returnInside,
                                             diffs: returnDiffs };
    const sameSet = J([...RD.orderOf(afterReturn)].sort()) === J([...originalOrder].sort());
    record('R8.1', 'the return finds the list exactly as the session left it — group set ' +
      'identical, every group\'s containers identical as identity-scoped multisets, ' +
      'within-container order exact, duplicates retained',
      afterReturn.present === true && sameSet && returnDiffs.length === 0,
      () => `group set identical ${sameSet}; ${returnDiffs.length} difference(s)` +
        `${returnDiffs.length ? ` — ${returnDiffs.join('; ')}` : ''}\n          ` +
        `this view's own 'original' sequence ${J(RD.orderOf(afterReturn))}\n          ` +
        `(the first view's was ${J(originalOrder)} — OG's per-view choice, ` +
        `observed, not asserted)`);

    // =====================================================================
    // R9 — the read-only claim, closed with a hash
    // =====================================================================
    say('\nR9  the whole session was read-only; the graph, hashed, proves it');
    phase('read-only-accounting', 'hash-the-graph-with-the-application-still-open');
    const midway = GH.snapshot(GRAPH);
    const midCmp = GH.compare(before, midway);
    record('R9.1', 'both panels, the reorder cycle, the language round-trip, the keyboard and ' +
      'the re-entry wrote nothing at all',
      midCmp.content.length === 0,
      midCmp.content.length ? J(midCmp.content.map((c) => `${c.change} ${c.file}`))
                            : `0 content changes across ${midCmp.afterCount} files`);
    record('R9.2', 'and the control page is byte-identical while the application is open',
      CG.readPage(GRAPH, CG.CONTROL_FILE) === controlBefore, CG.CONTROL_FILE);
  } finally {
    errorEvidence = await session.collectErrorEvidence();
    await APP.close(session, { say });
  }

  // ---------- R10 : after close ----------
  say('\nR10 the graph after the application has closed');
  const after = GH.snapshot(GRAPH);
  const cmp = GH.compare(before, after);
  record('R10.1', 'nothing changed at all — this run declared no write and made none',
    cmp.content.length === 0,
    cmp.content.length ? J(cmp.content.map((c) => `${c.change} ${c.file}`))
                       : `0 content changes across ${cmp.afterCount} files`);
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
  const inFeature = split.remaining.filter((e) => FEATURE_PHASES.includes(e.phase));
  record('R10.2', 'no window error arrived in any phase that operated these components',
    inFeature.length === 0,
    () => `${inFeature.length} in the feature phases; ${split.remaining.length} unexplained ` +
      `in total${split.remaining.length ? ` (${split.remaining.map((e) => e.phase).join(', ')})` : ''}`);
  record('R10.3', 'every window error was entitled; ONLY the exact browser notice is ever ' +
    'exempted — a refused `[frontend.handler]` line FAILS this check, as the rule requires',
    split.remaining.length === 0,
    () => `${errors.entries().length} captured across ${J(cls.byPhase)}; ` +
      `${cls.expected.length} expected, ${split.noise.length} exempted, ` +
      `${split.refused.length} handler line(s) refused by the rule, ` +
      `${split.remaining.length} unexplained` +
      (split.remaining.length ? `: ${EC.describe(split.remaining, 1)[0]}` : ''));
  const leftovers = ownedTree.filter(OP.alive);
  record('R10.4', 'every process this run owned has exited', leftovers.length === 0,
    leftovers.length ? J(leftovers)
                     : `${ownedTree.length} process(es) owned at launch, none still alive`);

  const pass = results.filter((r) => r.ok).length;
  const out = path.join(EVIDENCE, `f28-disclosure-regression-${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify({ results, observations, graph: GRAPH }, null, 2));
  say(`\n  ${pass}/${results.length} checks passed`);
  say(`  evidence: ${out}\n`);
  if (pass !== results.length) process.exitCode = 1;
}

main().catch((e) => { say(`\nFAILED: ${e.stack || e.message}\n`); process.exitCode = 1; });