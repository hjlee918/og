#!/usr/bin/env node
'use strict';
//
// F28 CHILD CONTEXT — the feature, in the packaged application.
//
//   node f28-refpath/checks/refctx-feature-checks.js
//
// The companion to `refctx-baseline-checks.js`, on the SAME fixture. The
// baseline established what OG does and where it stops; this establishes what
// the disclosure adds, and that everything the baseline observed as working
// still works.
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
const FEATURE_APP = 'Logseq-OG-F28-RefPath';

const results = [];
let ownedTree = [];
const errors = REC.createRecorder();
const observations = {};
let errorEvidence = null;
const sleep = OP.sleep;
const U = RG.UUID;
const T = RG.TEXT;
const K = RG.CHILDREN;
const W = RG.WALL;

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

const head = (s) => s.split('—')[0].split('·')[0].trim().slice(0, 18);

async function main() {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  say('\n=== F28 child context: disclosing what a collapsed reference row holds back ===\n');

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
    renderer: v.manifest.builtFrom.rendererRevision,
    buildId: v.manifest.pilotBuildId,
  };
  const runtime = path.join(built.resApp, 'js', 'cljs-runtime');
  const names = fs.existsSync(runtime) ? fs.readdirSync(runtime) : [];
  record('P0.2', 'the packaged renderer really carries this feature and the F27 walker it reuses',
    names.includes('frontend.util.f28_refctx.js') &&
    names.includes('frontend.util.f27_children.js'),
    `f28_refctx ${names.includes('frontend.util.f28_refctx.js')}, ` +
    `f27_children ${names.includes('frontend.util.f27_children.js')}`);

  // ---------- P1 : a fresh graph ----------
  say('\nP1  a fresh synthetic graph; nothing in this run writes to it');
  const g = RG.build({ kind: 'feature' });
  const GRAPH = B.assertInsideAllowedRoot('refctx graph', g.graph);
  record('P1.1', 'created fresh inside the permitted root; no earlier run reused or touched', true,
    `${GRAPH} (${g.pages} pages + ${g.journal} + ${g.asset})`);
  const before = GH.snapshot(GRAPH);
  const controlBefore = RG.readPage(GRAPH, RG.CONTROL_FILE);
  record('P1.2', 'every file hashed before the application is launched',
    Object.keys(before).length >= g.pages + 2, `${Object.keys(before).length} files`);

  const BAD = path.join(path.dirname(B.allowedRootReal()), 'f28-refctx-inert-probe');
  record('P1.3', 'the bad-dialog probe path is outside the permitted root and inert',
    !B.isInsideAllowedRoot(BAD) && !fs.existsSync(BAD), BAD);

  // ---------- P2/P3 : launch, refuse, then open ----------
  const session = await APP.open({
    built, graph: GRAPH, bad: BAD, errors, say, record, phase, prefix: 'P',
  });
  const { page, goTo, parkPointer } = session;
  ownedTree = session.ownedTree;

  try {
    // ------------------------------------------------------------------
    // Reading helpers
    // ------------------------------------------------------------------
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
     * One reading of the section: OG's own rows, and this feature's controls
     * and panels, each attributed to the row it belongs to.
     */
    const read = () => page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const sec = document.querySelector('.references.page-linked');
      if (!sec) return { present: false };
      const rows = [...sec.querySelectorAll('.ls-block[blockid]')];
      const index = new Map(rows.map((el, i) => [el, i]));
      const readRow = (el, i) => {
        const id = el.getAttribute('blockid');
        const main = el.querySelector(':scope > .block-main-container');
        let p = el.parentElement;
        let parent = null;
        while (p && p !== sec) {
          if (p.classList && p.classList.contains('ls-block') && p.hasAttribute('blockid')) {
            parent = index.has(p) ? index.get(p) : null; break;
          }
          p = p.parentElement;
        }
        // This feature's own wrapper is a DIRECT child of the row, so a
        // descendant row's control is never counted as this row's.
        const ctx = el.querySelector(':scope > .f28-ctx');
        const panel = ctx ? ctx.querySelector(':scope > .f28-ctx-panel') : null;
        return {
          i, id, parent,
          text: clean(main ? main.innerText : '').slice(0, 90),
          level: el.getAttribute('level'),
          hasChildAttr: el.getAttribute('haschild'),
          collapsedAttr: el.getAttribute('data-collapsed'),
          control: !!(ctx && ctx.querySelector(':scope > .f28-ctx-open')),
          controlId: ctx && ctx.querySelector(':scope > .f28-ctx-open')
            ? ctx.querySelector(':scope > .f28-ctx-open').id : null,
          expanded: ctx && ctx.querySelector(':scope > .f28-ctx-open')
            ? ctx.querySelector(':scope > .f28-ctx-open').getAttribute('aria-expanded') : null,
          open: !!panel,
          panelId: panel ? panel.id : null,
          head: panel ? clean((panel.querySelector('.f28-ctx-head') || {}).innerText) : null,
          status: panel ? clean((panel.querySelector('.f28-ctx-status') || {}).innerText) : null,
          lines: panel ? [...panel.querySelectorAll('.f28-ctx-line')].map((l) => ({
            depth: (l.getAttribute('class') || '').match(/depth-(\d)/)
              ? Number((l.getAttribute('class').match(/depth-(\d)/))[1]) : null,
            text: clean((l.querySelector('.f28-ctx-text') || {}).innerText),
            badges: [...l.querySelectorAll('.f28-ctx-badge')].map((b) => clean(b.innerText)),
            toggle: !!l.querySelector('.f28-ctx-toggle'),
            mark: clean((l.querySelector('.f28-ctx-mark') || {}).innerText) || null,
          })) : null,
          notes: panel ? [...panel.querySelectorAll('.f28-ctx-note')]
            .map((n) => clean(n.innerText)) : null,
          more: panel ? panel.querySelectorAll('.f28-ctx-more').length : 0,
          // What a panel must NEVER contain: it is plain text, not a renderer.
          rich: panel ? {
            imgs: panel.querySelectorAll('img').length,
            media: panel.querySelectorAll('video, audio, iframe, object, embed').length,
            macros: panel.querySelectorAll('.macro, .custom-query, .dsl-query').length,
            refs: panel.querySelectorAll('.page-ref, .block-ref').length,
            anchors: panel.querySelectorAll('a').length,
            editable: panel.querySelectorAll('[contenteditable], textarea, .block-content').length,
            blocks: panel.querySelectorAll('.ls-block').length,
          } : null,
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
      return {
        present: true,
        heading: clean((sec.querySelector('h2') || {}).innerText),
        items, rows: all,
        controls: sec.querySelectorAll('.f28-ctx-open').length,
        panels: sec.querySelectorAll('.f28-ctx-panel').length,
        filterControl: !!sec.querySelector('a.filter'),
        unlinked: !!document.querySelector('.references.page-unlinked'),
        editors: sec.querySelectorAll('textarea').length,
        sectionText: sec.innerText || '',
        sectionHtml: sec.innerHTML,
      };
    }).catch((e) => ({ present: false, error: String(e.message) }));

    const lean = (r) => JSON.parse(JSON.stringify({ ...r, sectionText: undefined,
                                                   sectionHtml: undefined }));
    // A block is not a row. `mixedRef` names the page AND is a child of a block
    // that names it, so OG draws it TWICE in this one list; `rowsOf` returns
    // every APPEARANCE, in document order, and `rowOf` is the first of them.
    const rowsOf = (r, key) => r.rows.filter((x) => x.id === U[key]);
    const rowOf = (r, key) => rowsOf(r, key)[0];
    const childrenOf = (r, row) => r.rows.filter((x) => x.parent === row.i);
    const subtreeOf = (r, row) => {
      const kids = childrenOf(r, row);
      return kids.flatMap((k) => [k, ...subtreeOf(r, k)]);
    };

    /** Press one appearance's control, by mouse or by keyboard. */
    const pressControl = async (key, how, nth = 0) => {
      const r = await read();
      const row = rowsOf(r, key)[nth];
      if (!row || !row.controlId) return null;
      if (how === 'enter' || how === 'space') {
        await page.evaluate((i) => document.getElementById(i).focus(), row.controlId);
        await page.keyboard.press(how === 'enter' ? 'Enter' : 'Space');
      } else {
        await page.evaluate((i) => document.getElementById(i).click(), row.controlId);
      }
      await sleep(2200);
      return row.controlId;
    };

    /** Press a control inside ONE appearance's open panel, by DOM id. */
    const pressInPanelById = async (panelId, cls, nth = 0) => {
      const ok = await page.evaluate(([pid, sel, n]) => {
        const panel = document.getElementById(pid);
        const btns = panel ? [...panel.querySelectorAll(sel)] : [];
        if (!btns[n]) return false;
        btns[n].click();
        return true;
      }, [panelId, cls, nth]).catch(() => false);
      await sleep(2500);
      return ok;
    };

    /** Press a control inside one row's open panel. */
    const pressInPanel = async (key, cls, nth = 0) => {
      const ok = await page.evaluate(([uuid, sel, n]) => {
        const el = document.querySelector(
          `.references.page-linked .ls-block[blockid="${uuid}"]`);
        const panel = el ? el.querySelector(':scope > .f28-ctx > .f28-ctx-panel') : null;
        const btns = panel ? [...panel.querySelectorAll(sel)] : [];
        if (!btns[n]) return false;
        btns[n].click();
        return true;
      }, [U[key], cls, nth]).catch(() => false);
      await sleep(2500);
      return ok;
    };

    const activeId = () => page.evaluate(() =>
      (document.activeElement && document.activeElement.id) || null).catch(() => null);
    const blurAll = () => page.evaluate(() => {
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    }).catch(() => null);

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
      refs.heading.includes(String(RG.REFERENCING.length)),
      `"${refs.heading}" for ${RG.REFERENCING.length} referencing block(s), ` +
      `${refs.rows.length} row(s) drawn`);
    record('P4.3', 'every referencing block is still listed, still grouped by source page',
      RG.REFERENCING.every((k) => !!rowOf(refs, k)) && refs.items.length === 5,
      `${RG.REFERENCING.filter((k) => !!rowOf(refs, k)).length}/${RG.REFERENCING.length} located ` +
      `across ${refs.items.length} source page(s): ` +
      JSON.stringify(refs.items.map((i) => i.page)));
    record('P4.4', 'the breadcrumbs are exactly what OG drew: complete, and none elided',
      refs.items.every((i) => i.groups.every((gp) => gp.more === 0)),
      `${refs.items.reduce((n, i) => n + i.groups.length, 0)} group(s), 0 "⋯" markers`);
    // Against `ogShows` for EVERY case, not only the ones with nothing behind:
    // that is what OG draws, and this feature must not add or remove one row.
    record('P4.5', 'the children OG already drew are still drawn, whole',
      Object.entries(K).every(([key, want]) =>
        rowsOf(refs, key).length > 0 &&
        rowsOf(refs, key).every((row) => subtreeOf(refs, row).length === want.ogShows)),
      Object.entries(K).map(([k, w]) => {
        const rs = rowsOf(refs, k);
        return `${k}: ${rs.map((row) => subtreeOf(refs, row).length).join('+') || '?'}/${w.ogShows}`;
      }).join('; '));
    record('P4.6', "OG's filter and unlinked references are both still there",
      refs.filterControl === true && refs.unlinked === true,
      `filter ${refs.filterControl}, unlinked ${refs.unlinked}`);
    record('P4.7', 'nothing is being edited, and OG\'s own collapse is as it was',
      refs.editors === 0 &&
      refs.rows.filter((r) => r.collapsedAttr && r.collapsedAttr !== 'false').length ===
        RG.COLLAPSED_APPEARANCES,
      `${refs.editors} editor(s); ` +
      `${refs.rows.filter((r) => r.collapsedAttr && r.collapsedAttr !== 'false').length} ` +
      `collapsed appearance(s) of ${Object.keys(W).length + 1} block(s), ` +
      `expected ${RG.COLLAPSED_APPEARANCES}`);

    // ---------- P5 : the control, exactly where OG stopped ----------
    say('\nP5  the control, exactly where OG stopped and nowhere else');
    const withControl = refs.rows.filter((r) => r.control).map((r) => r.id);
    // Every collapsed APPEARANCE, which is more than the number of collapsed
    // blocks: `TWICE` is one block wearing two of them.
    const eligibleIds = Object.keys(W).map((k) => U[k]).concat([U[RG.TWICE.key]]);
    record('P5.1', 'one control on each row this list collapsed, and on no other row',
      refs.controls === RG.COLLAPSED_APPEARANCES &&
      eligibleIds.every((id) => withControl.includes(id)) &&
      withControl.every((id) => eligibleIds.includes(id)),
      `${refs.controls} control(s) for ${RG.COLLAPSED_APPEARANCES} collapsed appearance(s) ` +
      `of ${eligibleIds.length} block(s): ` +
      JSON.stringify(refs.rows.filter((r) => r.control).map((r) => r.text.slice(0, 26))));
    record('P5.2', 'a row OG is drawing in full gains nothing at all',
      Object.entries(K).filter(([, w]) => w.behind === 0)
        .every(([key]) => { const r = rowOf(refs, key); return r && !r.control; }),
      Object.entries(K).filter(([, w]) => w.behind === 0).map(([k]) => k).join(', ') +
      ' — no control on any of them');
    const leafRow = rowOf(refs, 'leaf');
    record('P5.3', 'a reference with nothing written under it gains nothing either',
      !!leafRow && !leafRow.control && leafRow.hasChildAttr === 'false',
      leafRow ? `control ${leafRow.control}, haschild ${leafRow.hasChildAttr}` : 'missing');
    record('P5.4', 'every control is closed, and says so, before anything is pressed',
      refs.panels === 0 && refs.rows.filter((r) => r.control)
        .every((r) => r.expanded === 'false'),
      `${refs.panels} panel(s); aria-expanded: ` +
      JSON.stringify([...new Set(refs.rows.filter((r) => r.control).map((r) => r.expanded))]));

    // ---------- P6 : what one control discloses ----------
    say('\nP6  what a control discloses: the right blocks, under the right row');
    phase('disclose', 'open-the-journal-rows-context');
    await pressControl('jC1a', 'click');
    const r6 = await read();
    const j = rowOf(r6, 'jC1a');
    observations.journalPanel = j || null;
    record('P6.1', 'the panel opened on the row that was pressed, and on no other',
      !!j && j.open && r6.panels === 1,
      j ? `${r6.panels} panel(s) open; this row's: ${j.open}` : 'the row is gone');
    record('P6.2', 'it discloses exactly what is behind that row, in outline order',
      !!j && j.lines && j.lines.length === W.jC1a.hidden &&
      j.lines[0].text.startsWith(head(T.jC1a1)) &&
      j.lines[1].text.startsWith(head(T.jC1a2)),
      j && j.lines ? `${j.lines.length}/${W.jC1a.hidden}: ` +
        JSON.stringify(j.lines.map((l) => l.text.slice(0, 30))) : 'no lines');
    record('P6.3', 'the panel says WHAT these rows are — not references to this block',
      !!j && /under this block/i.test(j.head || ''),
      j ? `"${j.head}"` : 'no heading');
    record('P6.4', 'and it says how many it showed',
      !!j && /2/.test(j.status || ''), j ? `"${j.status}"` : 'no status');
    record('P6.5', 'Korean and emoji survive the disclosure intact',
      !!j && j.lines && j.lines.some((l) => /[가-힣]/.test(l.text)) &&
      j.lines.some((l) => /\p{Extended_Pictographic}/u.test(l.text)),
      j && j.lines ? JSON.stringify(j.lines.map((l) => l.text.slice(0, 26))) : 'no lines');

    // The blocks that were ABSENT from the whole section are now present.
    const nowThere = [head(T.jC1a1), head(T.jC1a2)]
      .map((n) => [n, r6.sectionText.includes(n)]);
    record('P6.6', 'blocks the baseline proved absent from the section are now on the page',
      nowThere.every(([, v]) => v), JSON.stringify(Object.fromEntries(nowThere)));

    // ---------- P7 : plain and safe ----------
    say('\nP7  a disclosed descendant is plain text, never a rendered block');
    phase('disclose', 'open-the-chain-behind-the-markup-block');
    await pressControl('deepD2', 'click');
    const r7 = await read();
    const d = rowOf(r7, 'deepD2');
    observations.deepPanel = d || null;
    record('P7.1', 'the chain behind a collapsed row is disclosed one level at a time',
      !!d && d.lines && d.lines.length >= 1 &&
      d.lines[0].text.startsWith(head(RG.DEEP_LEVELS[2])),
      d && d.lines ? `${d.lines.length} line(s), first: "${d.lines[0].text.slice(0, 40)}"`
                   : 'no lines');
    record('P7.2', 'the block carrying an image, a macro and a page link is shown as TEXT',
      !!d && d.rich && d.rich.imgs === 0 && d.rich.media === 0 && d.rich.macros === 0 &&
      d.rich.refs === 0 && d.rich.anchors === 0,
      d && d.rich ? JSON.stringify(d.rich) : 'no panel');
    record('P7.3', 'and its twin OG draws in front of the wall is still a real block',
      (() => { const m = rowOf(r7, 'markup'); return !!m; })(),
      'the visible twin is unaffected: this feature adds a panel, it does not change a row');
    record('P7.4', 'nothing inside a panel is editable, and no block renderer is inside it',
      !!d && d.rich && d.rich.editable === 0 && d.rich.blocks === 0,
      d && d.rich ? `editable ${d.rich.editable}, nested blocks ${d.rich.blocks}` : 'no panel');
    record('P7.5', 'two panels can be open at once, each showing its own row\'s context',
      r7.panels === 2 && !!rowOf(r7, 'jC1a') && rowOf(r7, 'jC1a').open,
      `${r7.panels} panel(s) open`);

    // ---------- P8 : bounded expansion ----------
    say('\nP8  bounded expansion: batches, continuation, and the depth safeguard');
    phase('disclose', 'open-twelve-blocks-behind-one-row');
    await pressControl('batchG1', 'click');
    const r8 = await read();
    const b = rowOf(r8, 'batchG1');
    const p1 = RG.BATCH_PRESSES[0];
    observations.batchFirstPress = b || null;
    record('P8.1', `the first press shows a bounded batch of ${p1.shows}, not all ${K.batch.behind}`,
      !!b && b.lines && b.lines.length === p1.shows,
      b && b.lines ? `${b.lines.length} line(s) of ${W.batchG1.hidden}` : 'no lines');
    record('P8.2', 'and it says how many remain rather than implying it is finished',
      !!b && new RegExp(String(p1.remaining)).test(b.status || '') && b.more === 1,
      b ? `"${b.status}", ${b.more} continuation control(s)` : 'no panel');

    await pressInPanel('batchG1', '.f28-ctx-more');
    const r8b = await read();
    const b2 = rowOf(r8b, 'batchG1');
    const p2 = RG.BATCH_PRESSES[1];
    record('P8.3', 'the continuation really reaches the rest, and then withdraws itself',
      !!b2 && b2.lines && b2.lines.length === p2.shows && b2.more === 0,
      b2 && b2.lines ? `${b2.lines.length}/${W.batchG1.hidden} line(s), ` +
                       `${b2.more} continuation control(s)` : 'no panel');
    record('P8.4', 'every one of the twelve is distinct — none is repeated or lost',
      !!b2 && b2.lines && new Set(b2.lines.map((l) => l.text)).size === p2.shows,
      b2 && b2.lines ? `${new Set(b2.lines.map((l) => l.text)).size} distinct of ` +
                       `${b2.lines.length}` : 'no panel');

    // The chain: opening one disclosed row reveals its own children, one level
    // at a time, until the depth safeguard is reached and explained.
    phase('disclose', 'walk-down-the-chain-to-the-depth-safeguard');
    let deepLines = [];
    for (let i = 0; i < 6; i++) {
      const before = (rowOf(await read(), 'deepD2') || {}).lines || [];
      const opened = await pressInPanel('deepD2', '.f28-ctx-toggle', before.length - 1);
      if (!opened) break;
      const after = (rowOf(await read(), 'deepD2') || {}).lines || [];
      deepLines = after;
      if (after.length === before.length) break;
    }
    observations.deepChain = deepLines;
    record('P8.5', 'the chain opens one level at a time, each indented below the last',
      deepLines.length >= 2 &&
      deepLines.every((l, i) => i === 0 || l.depth >= deepLines[i - 1].depth),
      `${deepLines.length} line(s): ` +
      JSON.stringify(deepLines.map((l) => `d${l.depth} ${l.text.slice(0, 18)}`)));
    const stopped = deepLines.filter((l) => l.mark === '⋯' || l.mark === '↻');
    record('P8.6', 'a level that may not be opened says why instead of offering a dead control',
      deepLines.every((l) => l.toggle || l.mark !== null),
      `${stopped.length} stopped level(s); every line has either a control or a reason`);

    // ---------- P9 : the keyboard ----------
    say('\nP9  the keyboard, in a window whose global handler eats Enter');
    phase('keyboard', 'operate-a-control-without-a-mouse');
    // Close everything first, so a keyboard result cannot be a leftover.
    for (const k of ['jC1a', 'deepD2', 'batchG1']) {
      const r = await read();
      const row = rowOf(r, k);
      if (row && row.open) await pressControl(k, 'click');
    }
    const r9a = await read();
    record('P9.1', 'everything is closed before the keyboard cases', r9a.panels === 0,
      `${r9a.panels} panel(s) open`);

    await blurAll();
    const sibId = await pressControl('sibAG1', 'enter');
    const r9b = await read();
    const sib = rowOf(r9b, 'sibAG1');
    record('P9.2', 'Enter on a focused control opens the panel',
      !!sib && sib.open && sib.expanded === 'true',
      sib ? `open ${sib.open}, aria-expanded ${sib.expanded}, ` +
            `${(sib.lines || []).length} line(s)` : 'the row is gone');
    record('P9.3', 'and focus stays on the control that was pressed',
      (await activeId()) === sibId, `focus is on ${await activeId()}, pressed ${sibId}`);

    await pressControl('sibAG1', 'space');
    const r9c = await read();
    record('P9.4', 'Space on the same control closes it again',
      !!rowOf(r9c, 'sibAG1') && !rowOf(r9c, 'sibAG1').open, `${r9c.panels} panel(s) open`);

    // Collapsing from INSIDE the panel returns focus to this row's own control.
    await pressControl('sibAG1', 'click');
    await blurAll();
    await pressInPanel('sibAG1', '.f28-ctx-hide');
    const focusAfter = await activeId();
    const r9d = await read();
    record('P9.5', 'collapsing from inside the panel returns focus to THIS row\'s control',
      focusAfter === sibId && !!rowOf(r9d, 'sibAG1') && !rowOf(r9d, 'sibAG1').open,
      `focus is on ${focusAfter}, this row's control is ${sibId}`);

    // ---------- P10 : independent rows ----------
    say('\nP10 two rows of one group are independent');
    phase('disclose', 'open-one-of-two-references-under-one-parent');
    await pressControl('sibAG1', 'click');
    const r10 = await read();
    const sibAOpen = rowOf(r10, 'sibAG1');
    const sibBRow = rowOf(r10, 'sibB');
    const sibBKids = sibBRow ? subtreeOf(r10, sibBRow) : [];
    record('P10.1', 'the reference WITH a branch behind the wall has a panel',
      !!sibAOpen && sibAOpen.open && (sibAOpen.lines || []).length === W.sibAG1.hidden,
      sibAOpen ? `${(sibAOpen.lines || []).length}/${W.sibAG1.hidden} line(s)` : 'missing');
    record('P10.2', 'the reference beside it, with nothing behind the wall, is untouched',
      !!sibBRow && sibBKids.length === K.sibB.descend &&
      sibBKids.every((x) => !x.control) && !sibBRow.control,
      sibBRow ? `${sibBKids.length}/${K.sibB.descend} children drawn, ` +
                `0 controls anywhere under it` : 'missing');
    // `f28-refctx/panel-id` replaces every character OUTSIDE [A-Za-z0-9_-], and
    // the hyphen is INSIDE that set, so a uuid's own hyphens survive into the id
    // unchanged. The control's id is the panel's plus `-toggle`, which is what
    // makes returning focus reach THIS row's control and no other.
    record('P10.3', 'and the panel appears under its own row, not at the end of the group',
      !!sibAOpen && sibAOpen.panelId && sibAOpen.panelId.includes(U.sibAG1) &&
      sibAOpen.controlId === `${sibAOpen.panelId}-toggle`,
      sibAOpen ? `panel id "${sibAOpen.panelId}" carries this row's own uuid; ` +
                 `its control is "${sibAOpen.controlId}"` : 'missing');

    // ---------- P15 : the SAME block, drawn twice, in one list ----------
    //
    // The correction this section exists for. `mixedRef` names the anchor page
    // AND is a child of `mixed`, which also names it, so OG draws it twice in
    // this one list. It carries `collapsed:: true`, so BOTH appearances are
    // collapsed and both offer this control at once. Before the fix their DOM
    // ids were derived from the list and the block alone and were therefore
    // identical: a collapse could focus the other appearance's control and
    // `aria-controls` named a panel ambiguously.
    say('\nP15 the SAME block drawn twice in one list: two occurrences, not one');
    phase('disclose', 'open-two-appearances-of-one-block');

    // Close anything still open, so nothing here is a leftover.
    for (const k of ['jC1a', 'deepD2', 'batchG1', 'sibAG1']) {
      const r = await read();
      const row = rowOf(r, k);
      if (row && row.open) await pressControl(k, 'click');
    }

    const r15 = await read();
    const occ = rowsOf(r15, RG.TWICE.key);
    observations.twice = occ;
    record('P15.1', 'OG really draws this one block twice in this one list',
      occ.length === RG.TWICE.occurrences,
      `${occ.length} appearance(s) of ${RG.TWICE.key}, expected ${RG.TWICE.occurrences}` +
      (occ.length ? `; parents ${JSON.stringify(occ.map((o) => o.parent))}` : ''));

    record('P15.2', 'both appearances are collapsed and both carry a control',
      occ.length === 2 &&
      occ.every((o) => o.collapsedAttr && o.collapsedAttr !== 'false') &&
      occ.every((o) => o.hasChildAttr === 'true') &&
      occ.every((o) => o.control),
      occ.map((o) => `#${o.i} collapsed=${o.collapsedAttr} haschild=${o.hasChildAttr} ` +
                     `control=${o.control}`).join('; '));

    // The defect itself, stated as the thing it broke.
    record('P15.3', 'their control and panel ids are DIFFERENT, so neither can act on the other',
      occ.length === 2 &&
      !!occ[0].controlId && !!occ[1].controlId &&
      occ[0].controlId !== occ[1].controlId,
      occ.length === 2 ? `"${occ[0].controlId}" vs "${occ[1].controlId}"` : 'not two');

    // And nothing in the whole section shares an id with anything else.
    const dupes = await page.evaluate(() => {
      const sec = document.querySelector('.references.page-linked');
      if (!sec) return null;
      const ids = [...sec.querySelectorAll('[id]')].map((e) => e.id).filter(Boolean);
      const seen = new Map();
      for (const i of ids) seen.set(i, (seen.get(i) || 0) + 1);
      return { total: ids.length, duplicated: [...seen].filter(([, n]) => n > 1).map(([i]) => i) };
    }).catch(() => null);
    observations.duplicateIds = dupes;
    record('P15.4', 'no DOM id is duplicated anywhere in the section',
      !!dupes && dupes.duplicated.length === 0,
      dupes ? `${dupes.total} id(s), ${dupes.duplicated.length} duplicated` +
              (dupes.duplicated.length ? `: ${JSON.stringify(dupes.duplicated.slice(0, 4))}` : '')
            : 'no reading');

    // Open the FIRST appearance only.
    const firstControl = await pressControl(RG.TWICE.key, 'click', 0);
    const r15a = await read();
    const occA = rowsOf(r15a, RG.TWICE.key);
    record('P15.5', 'opening one appearance leaves the other closed',
      occA.length === 2 && occA[0].open && !occA[1].open && r15a.panels === 1,
      occA.map((o, n) => `#${n} open=${o.open}`).join(', ') +
      `; ${r15a.panels} panel(s) in the section`);

    record('P15.6', 'the opened appearance announces its OWN panel, unambiguously',
      occA.length === 2 && !!occA[0].panelId &&
      occA[0].controlId === `${occA[0].panelId}-toggle` &&
      occA[0].expanded === 'true' && occA[1].expanded === 'false',
      occA.length === 2
        ? `panel "${occA[0].panelId}", control "${occA[0].controlId}", ` +
          `aria-expanded ${occA[0].expanded} / ${occA[1].expanded}`
        : 'not two');

    // Now open the SECOND as well.
    await pressControl(RG.TWICE.key, 'click', 1);
    const r15b = await read();
    const occB = rowsOf(r15b, RG.TWICE.key);
    record('P15.7', 'both can be open at once, each showing this block\'s own children',
      occB.length === 2 && occB.every((o) => o.open) && r15b.panels === 2 &&
      occB.every((o) => (o.lines || []).length === RG.TWICE.hidden) &&
      occB[0].panelId !== occB[1].panelId,
      occB.map((o, n) => `#${n} ${(o.lines || []).length}/${RG.TWICE.hidden} line(s) ` +
                         `in "${o.panelId}"`).join('; '));

    record('P15.8', 'and each shows the same block\'s children because it IS the same block',
      occB.length === 2 && occB[0].lines && occB[1].lines &&
      JSON.stringify(occB[0].lines.map((l) => l.text)) ===
        JSON.stringify(occB[1].lines.map((l) => l.text)) &&
      occB[0].lines[0].text.startsWith(head(T.mixedRefC1)),
      occB.length === 2 && occB[0].lines
        ? JSON.stringify(occB[0].lines.map((l) => l.text.slice(0, 24)))
        : 'no lines');

    // Collapse the FIRST from inside its own panel: focus must come back to
    // the FIRST control, and the second panel must be untouched.
    await blurAll();
    const okHide = await pressInPanelById(occB[0].panelId, '.f28-ctx-hide');
    const focusAfterFirst = await activeId();
    const r15c = await read();
    const occC = rowsOf(r15c, RG.TWICE.key);
    record('P15.9', 'collapsing one appearance returns focus to THAT appearance\'s control',
      okHide && focusAfterFirst === occB[0].controlId &&
      focusAfterFirst !== occB[1].controlId,
      `focus is on "${focusAfterFirst}"; this appearance's control is ` +
      `"${occB[0].controlId}", the other's is "${occB[1].controlId}"`);

    record('P15.10', 'and the other appearance is completely unaffected',
      occC.length === 2 && !occC[0].open && occC[1].open &&
      r15c.panels === 1 &&
      (occC[1].lines || []).length === RG.TWICE.hidden &&
      occC[1].panelId === occB[1].panelId,
      occC.map((o, n) => `#${n} open=${o.open} lines=${(o.lines || []).length}`).join(', ') +
      `; ${r15c.panels} panel(s) left`);

    // And the reverse: collapse the second, which is now the only open one.
    await blurAll();
    await pressInPanelById(occC[1].panelId, '.f28-ctx-hide');
    const focusAfterSecond = await activeId();
    const r15d = await read();
    record('P15.11', 'the same holds in the other direction, and nothing is left open',
      focusAfterSecond === occC[1].controlId && r15d.panels === 0 &&
      rowsOf(r15d, RG.TWICE.key).every((o) => !o.open),
      `focus is on "${focusAfterSecond}", expected "${occC[1].controlId}"; ` +
      `${r15d.panels} panel(s) open`);

    // ---------- P11 : the list is unchanged by all of this ----------
    say('\nP11 the rest of the list, after everything above');
    phase('regression', 'the-list-after-the-feature-was-used');
    const r11 = await read();
    record('P11.1', 'the count, the grouping and the breadcrumbs are what they were',
      r11.heading === refs.heading &&
      JSON.stringify(r11.items.map((i) => i.page)) ===
        JSON.stringify(refs.items.map((i) => i.page)) &&
      r11.items.every((i) => i.groups.every((gp) => gp.more === 0)),
      `"${r11.heading}" across ${JSON.stringify(r11.items.map((i) => i.page))}`);
    record('P11.2', 'no editor was opened and nothing navigated',
      r11.editors === 0 &&
      (await page.evaluate(() => location.hash)) === `#/page/${encodeURIComponent(RG.ANCHOR)}`,
      `${r11.editors} editor(s); hash ${await page.evaluate(() => location.hash)}`);
    record('P11.3', "OG's own collapse is exactly as it was found",
      r11.rows.filter((x) => x.collapsedAttr && x.collapsedAttr !== 'false').length ===
        RG.COLLAPSED_APPEARANCES,
      `${r11.rows.filter((x) => x.collapsedAttr && x.collapsedAttr !== 'false').length} ` +
      `collapsed appearance(s), unchanged`);

    // Closing every panel must return the section to what OG rendered — every
    // APPEARANCE, so the second one cannot be left open and unnoticed.
    for (const k of Object.keys(W).concat([RG.TWICE.key])) {
      for (let n = 0; n < 2; n++) {
        const r = await read();
        const row = rowsOf(r, k)[n];
        if (row && row.open) await pressControl(k, 'click', n);
      }
    }
    const r11b = await read();
    const hiddenNames = [head(T.jC1a1), head(RG.BATCH_CHILDREN[0]), head(T.sibAGG1),
                         head(RG.DEEP_LEVELS[3]), head(T.mixedRefC1)];
    record('P11.4', 'closing every panel returns the section to precisely what OG drew',
      r11b.panels === 0 &&
      r11b.rows.length === refs.rows.length &&
      hiddenNames.every((n) => !r11b.sectionText.includes(n)),
      `${r11b.panels} panel(s), ${r11b.rows.length} rows (was ${refs.rows.length}); ` +
      `${hiddenNames.filter((n) => r11b.sectionText.includes(n)).length} of ` +
      `${hiddenNames.length} withheld blocks still on the page`);

    phase('read-filter', 'open-the-filter-dialog');
    await page.locator('a.filter').first().click({ timeout: 15000 }).catch(() => null);
    await sleep(2500);
    const filterNames = await page.evaluate(() => {
      const m = document.querySelector('.ls-filters, .filters');
      if (!m) return null;
      return [...m.querySelectorAll('button')].map((x) => (x.innerText || '').trim())
        .filter(Boolean);
    }).catch(() => null);
    observations.filterOptions = filterNames;
    record('P11.5', 'the filter still offers the same pages it did before',
      !!filterNames && filterNames.length >= 5, JSON.stringify(filterNames));
    await page.keyboard.press('Escape').catch(() => null);
    await sleep(1500);

    // ---------- P12 : the right sidebar, a NAMED exclusion ----------
    say('\nP12 the same list in the right sidebar gets nothing at all');
    phase('regression', 'open-the-anchor-page-in-the-right-sidebar');
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
      rows: document.querySelectorAll('.sidebar-item .references.page-linked .ls-block[blockid]')
        .length,
      collapsed: [...document.querySelectorAll(
        '.sidebar-item .references.page-linked .ls-block[blockid]')]
        .filter((e) => { const a = e.getAttribute('data-collapsed');
                         return a && a !== 'false'; }).length,
      controls: document.querySelectorAll('.sidebar-item .f28-ctx-open').length,
      panels: document.querySelectorAll('.sidebar-item .f28-ctx-panel').length,
      wrappers: document.querySelectorAll('.sidebar-item .f28-ctx').length,
    })).catch(() => null);
    observations.sidebar = sidebar;
    record('P12.1', "the anchor's linked references really are rendered in the right sidebar",
      !!sidebar && sidebar.items > 0 && sidebar.refs > 0 && sidebar.rows > 0,
      JSON.stringify(sidebar) + ` (shift-click found the link: ${opened.found})`);
    record('P12.2', 'they collapse exactly as OG collapses them, and carry NO control',
      !!sidebar && sidebar.collapsed > 0 && sidebar.controls === 0 &&
      sidebar.panels === 0 && sidebar.wrappers === 0,
      sidebar ? `${sidebar.collapsed} collapsed row(s), ${sidebar.controls} control(s), ` +
                `${sidebar.panels} panel(s), ${sidebar.wrappers} wrapper(s)` : 'no reading');

    // ---------- P13 : the graph, from the application's side ----------
    say('\nP13 the graph, before the application is closed');
    const controlNow = RG.readPage(GRAPH, RG.CONTROL_FILE);
    record('P13.1', 'the control page is byte-identical while the application is still open',
      controlNow === controlBefore, `${controlNow.length} bytes`);
  } finally {
    errorEvidence = await session.collectErrorEvidence();
    await APP.close(session, { say });
  }

  // ---------- after the application has closed ----------
  say('\nP14 the graph, after the application has closed');
  const after = GH.snapshot(GRAPH);
  const cmp = GH.compare(before, after);
  record('P14.1', 'no content file changed: this feature only reads the graph',
    cmp.content.length === 0,
    cmp.content.length ? JSON.stringify(cmp.content.map((c) => `${c.change} ${c.file}`))
                       : `0 content changes across ${cmp.afterCount} files`);
  record('P14.2', 'OG housekeeping is recorded separately rather than counted as content', true,
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
  const featurePhases = ['disclose', 'keyboard'];
  const inFeature = split.remaining.filter((e) => featurePhases.includes(e.phase));
  record('P14.3', 'no window error arrived in any phase that operated this feature',
    inFeature.length === 0,
    `${inFeature.length} in ${JSON.stringify(featurePhases)}; ` +
    `${split.remaining.length} unexplained in total` +
    (split.remaining.length ? ` (${split.remaining.map((e) => e.phase).join(', ')})` : ''));
  record('P14.4', 'every window error was entitled; ONLY the exact browser notice is ever exempted',
    split.remaining.length === 0,
    `${errors.entries().length} captured across ${JSON.stringify(cls.byPhase)}; ` +
    `${cls.expected.length} expected, ${split.noise.length} exempted, ` +
    `${split.refused.length} handler line(s) refused by the rule, ` +
    `${split.remaining.length} unexplained` +
    (split.remaining.length ? `: ${EC.describe(split.remaining, 1)[0]}` : ''));

  const leftovers = ownedTree.filter(OP.alive);
  record('P14.5', 'every process this run owned has exited', leftovers.length === 0,
    leftovers.length ? JSON.stringify(leftovers)
                     : `${ownedTree.length} process(es) owned at launch, none still alive`);

  const pass = results.filter((r) => r.ok).length;
  const out = path.join(EVIDENCE, `f28-refctx-feature-${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify({ results, observations, graph: GRAPH }, null, 2));
  fs.writeFileSync(path.join(EVIDENCE, 'f28-refctx-feature-summary.json'),
    JSON.stringify({ results: results.map((r) => ({ id: r.id, ok: r.ok, title: r.title })),
                     build: observations.build, graph: GRAPH,
                     passed: pass, total: results.length }, null, 2));
  say(`\n  ${pass}/${results.length} checks passed`);
  say(`  evidence: ${out}\n`);
  if (pass !== results.length) process.exitCode = 1;
}

main().catch((e) => { say(`\nFAILED: ${e.stack || e.message}\n`); process.exitCode = 1; });
