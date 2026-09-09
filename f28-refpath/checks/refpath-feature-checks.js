#!/usr/bin/env node
'use strict';
//
// F28 STEP TWO — the source-path disclosure, in the packaged application.
//
//   node f28-refpath/checks/refpath-feature-checks.js
//
// The baseline run (`refpath-baseline-checks.js`) established what OG does. This
// one establishes what the feature adds, ON THE SAME FIXTURE, and — just as
// importantly — that everything the baseline observed as working still works:
// the grouping, the counts, the filter, the three breadcrumb steps, the
// unlinked-references section, and a graph nobody wrote to.
//
// WHAT THIS ASKS THAT A UNIT TEST CANNOT.
//
// `frontend.util.f28-refpath` is pure and is tested without a renderer. What
// only a real run can answer:
//
//   * whether the control appears exactly where OG cut the path, and NOWHERE
//     else — including the four references whose whole path OG already shows;
//   * whether the disclosed levels are the RIGHT ones, in the right order,
//     against a fixture that contains four identical ancestors and two branches
//     sharing five levels;
//   * whether a path deeper than one batch continues rather than lying;
//   * whether a step really is plain text — the fixture writes an image link and
//     a macro into an elided ancestor on purpose;
//   * whether the keyboard reaches it, in a window where OG's global shortcut
//     handler is installed and eats Enter;
//   * whether two panels are independent;
//   * whether anything at all was written to the graph.
//
// MANDATORY GRAPH-DATA BOUNDARY (project-notes/DATA_ACCESS_GUARDRAIL.md).
// Graph data is only ever this run's own synthetic graph inside
// ~/Library/Mobile Documents/com~apple~CloudDocs/Logseq Test. No personal graph
// is opened, read or enumerated, no earlier run's folder is touched, and the
// installed application is never launched. The loaded graph path is asserted
// BEFORE any feature interaction, and every file's hash is compared after the
// application has closed.
//
const fs = require('fs');
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
const APP_NAME = 'Logseq-OG-F28-RefPath';

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
const U = RG.UUID;

// A step is matched by a distinctive prefix of the ancestor's own text, because
// the panel bounds a long one with `…`.
const head = (s) => s.split('—')[0].trim().slice(0, 20);

async function main() {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  say('\n=== F28 step two: opening the rest of a linked reference\'s source path ===\n');

  // ---------- P0 : preconditions ----------
  say('P0  preconditions');
  const built = APP.resolve(APP_NAME);
  const v = built.preflight;
  record('P0.1', 'the packaged F28 build passes its own pre-load identity check', v.ok,
    v.ok ? `build ${v.manifest.pilotBuildId}, renderer ${v.manifest.builtFrom.rendererRevision}`
         : `${v.reason}: ${v.detail}`);
  if (!v.ok) throw new Error('preflight failed');
  record('P0.2', 'it is this branch\'s build, and neither accepted feature build',
    v.manifest.schema === 'f28-refpath/1' &&
      v.manifest.builtFrom.branch === 'feature/f28-reference-paths' &&
      v.manifest.rendererBuild.rebuiltHere === true &&
      v.manifest.builtFrom.rendererRevision !== '5b34566ca',
    `${v.manifest.schema} / ${v.manifest.builtFrom.branch} / ` +
    `renderer ${v.manifest.builtFrom.rendererRevision}`);
  observations.build = {
    app: built.appName, schema: v.manifest.schema,
    branch: v.manifest.builtFrom.branch, commit: v.manifest.builtFrom.commit,
    renderer: v.manifest.builtFrom.rendererRevision,
  };

  // ---------- P1 : a fresh graph ----------
  say('\nP1  a fresh synthetic graph; nothing in this run writes to it');
  const g = RG.build({ kind: 'feature' });
  const GRAPH = B.assertInsideAllowedRoot('refpath graph', g.graph);
  record('P1.1', 'created fresh inside the permitted root; no earlier run reused or touched', true,
    `${GRAPH} (${g.pages} pages + ${g.journal})`);
  const before = GH.snapshot(GRAPH);
  const controlBefore = before[RG.CONTROL_FILE];
  record('P1.2', 'every file hashed, including the control page nothing may reach',
    Object.keys(before).length >= g.pages + 2 && !!controlBefore,
    `${Object.keys(before).length} files; ${RG.CONTROL_FILE} ` +
    `${controlBefore ? controlBefore.sha256.slice(0, 16) + '…' : 'MISSING'}`);

  const BAD = path.join(path.dirname(B.allowedRootReal()), 'f28-refpath-inert-probe');
  record('P1.3', 'the bad-dialog probe path is outside the permitted root and inert',
    !B.isInsideAllowedRoot(BAD) && !fs.existsSync(BAD), BAD);

  // ---------- P2/P3 : launch, refuse, then open ----------
  const session = await APP.open({
    built, graph: GRAPH, bad: BAD, errors, say, record, phase, prefix: 'P',
  });
  const { app, page, goTo, parkPointer } = session;
  ownedTree = session.ownedTree;

  try {
    // ================= helpers =================

    /** Scroll the whole page until the rendered reference count settles. */
    const settle = async (label) => {
      const n = () => page.evaluate(() => document.querySelectorAll(
        '.references.page-linked .blocks-container [blockid]').length).catch(() => 0);
      let seen = -1; let stable = 0;
      for (let i = 0; i < 30 && stable < 3; i++) {
        await page.evaluate((step) => {
          const m = document.querySelector('#main-content-container') || document.body;
          const max = m.scrollHeight - m.clientHeight;
          m.scrollTop = max > 0 ? Math.min(max, (step % 6) * (max / 5)) : 0;
        }, i).catch(() => null);
        await sleep(1500);
        const c = await n();
        if (c === seen) stable += 1; else { seen = c; stable = 0; }
      }
      say(`          (${label}: settled at ${seen} rendered reference blocks)`);
      await parkPointer();
      return seen;
    };

    /**
     * One reading of the linked-references section: OG's own structure, and
     * every F28 control and panel inside it. Nothing here clicks.
     */
    const readRefs = () => page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const sec = document.querySelector('.references.page-linked');
      if (!sec) return { present: false };
      const items = [...sec.querySelectorAll('.references-blocks-item')].map((item) => {
        const header = item.querySelector('.foldable-title');
        const groups = [...item.querySelectorAll('.blocks-container')].map((bc) => {
          const wrap = bc.parentElement;
          // With F28 the wrapper is `.f28-path`; without it the breadcrumb is a
          // direct child. Both are read, so a group that lost its wrapper is
          // visible rather than silently skipped.
          const holder = wrap && wrap.classList.contains('f28-path')
            ? wrap : (wrap ? wrap.querySelector(':scope > .f28-path') : null);
          const crumb = (holder || wrap) &&
            (holder || wrap).querySelector(':scope > .breadcrumb');
          const steps = crumb
            ? [...crumb.children]
                .filter((c) => !c.classList.contains('ui__icon'))
                .map((c) => ({ tag: c.tagName, cls: c.getAttribute('class') || '',
                               text: clean(c.innerText) }))
            : [];
          const toggle = crumb ? crumb.querySelector('.f28-path-toggle') : null;
          const panel = holder ? holder.querySelector(':scope > .f28-path-panel') : null;
          return {
            wrapped: !!holder,
            crumb: crumb ? clean(crumb.innerText) : null,
            ogSteps: steps.filter((s) => !s.cls.includes('f28-path-toggle') &&
                                          s.text !== '⋯').map((s) => s.text),
            inertMore: steps.filter((s) => s.tag === 'SPAN' && s.text === '⋯' &&
                                            !s.cls.includes('f28')).length,
            toggle: toggle ? {
              tag: toggle.tagName,
              type: toggle.getAttribute('type'),
              id: toggle.id,
              expanded: toggle.getAttribute('aria-expanded'),
              controls: toggle.getAttribute('aria-controls'),
              label: toggle.getAttribute('aria-label') || '',
              title: toggle.getAttribute('title') || '',
              text: clean(toggle.innerText),
              focusable: toggle.tabIndex >= 0,
            } : null,
            panel: panel ? {
              id: panel.id,
              role: panel.getAttribute('role'),
              label: panel.getAttribute('aria-label') || '',
              pageLine: clean((panel.querySelector('.f28-path-page') || {}).innerText),
              steps: [...panel.querySelectorAll('.f28-path-step')].map((li) => ({
                level: clean((li.querySelector('.f28-path-level') || {}).innerText),
                badges: [...li.querySelectorAll('.f28-path-badge')]
                  .map((b) => clean(b.innerText)),
                text: clean((li.querySelector('.f28-path-text') || {}).innerText),
              })),
              status: clean((panel.querySelector('.f28-path-status') || {}).innerText),
              snapshot: clean((panel.querySelector('.f28-path-snapshot') || {}).innerText),
              incomplete: clean((panel.querySelector('.f28-path-incomplete') || {}).innerText),
              hasMore: !!panel.querySelector('.f28-path-more'),
              hasHide: !!panel.querySelector('.f28-path-hide'),
              // Safety: nothing OG renders may reach this surface.
              images: panel.querySelectorAll('img').length,
              iframes: panel.querySelectorAll('iframe, video, audio, embed, object').length,
              anchors: panel.querySelectorAll('a').length,
              macros: panel.querySelectorAll('.macro, .custom-query, .lazy-visibility').length,
              refs: panel.querySelectorAll('.block-ref, .page-ref').length,
              buttons: panel.querySelectorAll('button').length,
            } : null,
            blocks: [...new Set([...bc.querySelectorAll('[blockid]')]
              .map((b) => b.getAttribute('blockid')))],
          };
        });
        return { page: clean(header && header.innerText), groups };
      });
      return {
        present: true,
        heading: clean((sec.querySelector('h2') || {}).innerText),
        items,
        filterControl: !!sec.querySelector('a.filter'),
        unlinked: !!document.querySelector('.references.page-unlinked'),
        toggles: sec.querySelectorAll('.f28-path-toggle').length,
        panels: sec.querySelectorAll('.f28-path-panel').length,
        // The disclosure must never appear outside this section.
        togglesElsewhere: document.querySelectorAll('.f28-path-toggle').length -
                          sec.querySelectorAll('.f28-path-toggle').length,
        editors: document.querySelectorAll('textarea[aria-label="editing block"]').length,
        hash: location.hash,
      };
    }).catch((e) => ({ present: false, error: String(e.message) }));

    /** The group holding one fixture block, by its identity. */
    const groupOf = (refs, key) => {
      for (const item of refs.items) {
        for (const gp of item.groups) {
          if (gp.blocks.includes(U[key])) return { page: item.page, group: gp };
        }
      }
      return null;
    };

    /** Press one group's toggle, by the identity of a block inside it. */
    const pressToggle = async (key, how) => {
      const id = await page.evaluate((uuid) => {
        for (const bc of document.querySelectorAll(
          '.references.page-linked .blocks-container')) {
          const ids = [...bc.querySelectorAll('[blockid]')]
            .map((b) => b.getAttribute('blockid'));
          if (!ids.includes(uuid)) continue;
          const holder = bc.parentElement;
          const t = holder && holder.querySelector('.f28-path-toggle');
          return t ? t.id : null;
        }
        return null;
      }, U[key]).catch(() => null);
      if (!id) return null;
      if (how === 'keyboard-enter' || how === 'keyboard-space') {
        await page.evaluate((i) => document.getElementById(i).focus(), id);
        await page.keyboard.press(how === 'keyboard-enter' ? 'Enter' : 'Space');
      } else {
        await page.evaluate((i) => document.getElementById(i).click(), id);
      }
      await sleep(2200);
      return id;
    };

    /** Press a control inside one group's open panel. */
    const pressInPanel = async (key, cls) => {
      const ok = await page.evaluate(([uuid, sel]) => {
        for (const bc of document.querySelectorAll(
          '.references.page-linked .blocks-container')) {
          const ids = [...bc.querySelectorAll('[blockid]')]
            .map((b) => b.getAttribute('blockid'));
          if (!ids.includes(uuid)) continue;
          const btn = bc.parentElement && bc.parentElement.querySelector(sel);
          if (!btn) return false;
          btn.click();
          return true;
        }
        return false;
      }, [U[key], cls]).catch(() => false);
      await sleep(2200);
      return ok;
    };

    // ---------- P4 : OG's own list, unchanged ----------
    say('\nP4  everything the baseline observed as working, still working');
    phase('read-linked-references', 'open-the-anchor-page');
    await goTo(RG.ANCHOR);
    await settle('first reading');

    let refs = await readRefs();
    observations.initial = refs;
    record('P4.1', 'the linked-references section rendered', refs.present === true,
      refs.present ? refs.heading : `not present: ${refs.error || 'no section'}`);
    if (!refs.present) throw new Error('no linked-references section; not proceeding');

    const distinct = [...new Set(refs.items.flatMap(
      (i) => i.groups.flatMap((gp) => gp.blocks)))];
    record('P4.2', 'every referencing block is still listed, grouped by source page',
      distinct.length === 11 && refs.items.length === 4,
      `${distinct.length} referencing blocks across ${refs.items.length} pages: ` +
      JSON.stringify(refs.items.map((i) => i.page)));
    record('P4.3', 'the count, the filter control and unlinked references are unchanged',
      refs.heading.includes('11') && refs.filterControl && refs.unlinked,
      `"${refs.heading}", filter ${refs.filterControl}, unlinked ${refs.unlinked}`);
    record('P4.4', 'two references under one parent are still ONE group',
      (() => { const a = groupOf(refs, 'deepA'); const b = groupOf(refs, 'deepB');
               return !!a && !!b && a.group === b.group && a.group.blocks.length === 2; })(),
      (() => { const a = groupOf(refs, 'deepA');
               return a ? `${a.group.blocks.length} blocks in the group` : 'not found'; })());

    // OG's own three steps must be exactly what the baseline saw.
    const ogStepsOk = Object.keys(D).every((key) => {
      const f = groupOf(refs, key);
      return f && f.group.ogSteps.length === D[key].visible;
    });
    record('P4.5', "OG's own breadcrumb still shows exactly the levels it showed before",
      ogStepsOk,
      Object.keys(D).map((k) => {
        const f = groupOf(refs, k);
        return `${k}:${f ? f.group.ogSteps.length : '?'}/${D[k].visible}`;
      }).join(' '));

    // ---------- P5 : the control, exactly where the path was cut ----------
    say('\nP5  one control, exactly where OG cut the path');
    const withElision = Object.keys(D).filter((k) => D[k].hidden > 0);
    const withoutElision = Object.keys(D).filter((k) => D[k].hidden === 0);
    const hasToggle = (k) => { const f = groupOf(refs, k); return !!(f && f.group.toggle); };

    record('P5.1', 'every reference whose path OG cut has one control',
      withElision.every(hasToggle),
      withElision.map((k) => `${k}:${hasToggle(k) ? 'yes' : 'NO'}`).join(' '));
    record('P5.2', 'every reference whose whole path OG shows has NONE',
      withoutElision.every((k) => !hasToggle(k)),
      withoutElision.map((k) => `${k}:${hasToggle(k) ? 'HAS ONE' : 'none'}`).join(' '));
    // One control per GROUP, not per reference: deepA and deepB share a parent
    // and therefore share a breadcrumb. Derived from the groups actually
    // rendered rather than from a literal, so a change in grouping fails here
    // instead of being absorbed by an arithmetic constant.
    const elidedGroups = new Set(withElision.map((k) => (groupOf(refs, k) || {}).group));
    const inertLeft = refs.items.reduce(
      (n, i) => n + i.groups.reduce((m, gp) => m + gp.inertMore, 0), 0);
    record('P5.3', 'the inert marker is gone where the control replaced it, and nowhere else',
      inertLeft === 0 && refs.toggles === elidedGroups.size,
      `${refs.toggles} control(s) for ${withElision.length} elided reference(s) ` +
      `in ${elidedGroups.size} group(s); ${inertLeft} inert marker(s) left`);
    record('P5.4', 'the disclosure appears nowhere outside the linked-references section',
      refs.togglesElsewhere === 0, `${refs.togglesElsewhere} outside`);

    const tg = (groupOf(refs, 'deepA') || {}).group;
    record('P5.5', 'the control is a real button, focusable, labelled, and says it is closed',
      !!tg && !!tg.toggle && tg.toggle.tag === 'BUTTON' && tg.toggle.type === 'button' &&
        tg.toggle.focusable === true && tg.toggle.expanded === 'false' &&
        tg.toggle.label.length > 0 && tg.toggle.controls.length > 0,
      tg && tg.toggle ? JSON.stringify(tg.toggle) : 'no control on the deep group');
    record('P5.6', 'no panel is open before anything is pressed', refs.panels === 0,
      `${refs.panels} panel(s)`);

    // ---------- P6 : the deepest path, disclosed ----------
    say('\nP6  the seven-level path, opened');
    phase('disclose', 'press-the-control-on-the-7-deep-path');
    await pressToggle('deepA', 'click');
    refs = await readRefs();
    const deep = (groupOf(refs, 'deepA') || {}).group;
    const dp = deep && deep.panel;
    observations.deepPanel = dp;
    record('P6.1', 'a panel opened, named, and the control says so',
      !!dp && dp.role === 'group' && dp.label.length > 0 &&
        deep.toggle.expanded === 'true' && deep.toggle.controls === dp.id,
      dp ? `${dp.id} "${dp.label}"` : 'no panel');
    if (!dp) throw new Error('the disclosure did not open; not proceeding');

    const wantSteps = RG.PATHS.deepA.slice(0, D.deepA.hidden);
    record('P6.2', 'it shows exactly the levels OG did not, OUTERMOST FIRST',
      dp.steps.length === D.deepA.hidden &&
        wantSteps.every((t, i) => dp.steps[i].text.includes(head(t))),
      `${dp.steps.length} step(s): ${JSON.stringify(dp.steps.map((s) => s.text.slice(0, 26)))}`);
    record('P6.3', 'it names the source page and numbers the levels from it',
      dp.pageLine.includes(RG.DEEP_PAGE) &&
        dp.steps.map((s) => s.level).join(',') === '1.,2.,3.,4.',
      `"${dp.pageLine}" — levels ${JSON.stringify(dp.steps.map((s) => s.level))}`);
    record('P6.4', 'it says the whole path is now shown, and offers no continuation',
      /whole path/i.test(dp.status) && dp.hasMore === false && dp.hasHide === true &&
        dp.incomplete === '',
      `"${dp.status}" — more:${dp.hasMore} hide:${dp.hasHide}`);
    record('P6.5', 'it says its content was read when it was opened',
      dp.snapshot.length > 0, `"${dp.snapshot.slice(0, 90)}…"`);
    // The defect this run found the first time it was run: `:block/content` is
    // the raw file text, so an ancestor carrying a persisted `id::` showed
    // 36 characters of identifier as part of its step. Every ancestor of a
    // referable block is liable to have one, so this is not an edge case.
    const idLeak = dp.steps.filter((s) => /id::|[0-9a-f]{8}-[0-9a-f]{4}-/.test(s.text));
    record('P6.6', 'no step shows a block identifier: `id::` is not part of what a block says',
      idLeak.length === 0,
      idLeak.length ? `${idLeak.length} step(s) leak an identifier: ` +
                      JSON.stringify(idLeak.map((s) => s.text))
                    : `0 of ${dp.steps.length} steps mention id:: or a uuid; ` +
                      `the fixture's outermost ancestor carries one (${U.deepTop})`);
    record('P6.8', 'no level OG already shows is repeated in the panel',
      RG.PATHS.deepA.slice(D.deepA.hidden)
        .every((t) => !dp.steps.some((s) => s.text.includes(head(t)))),
      `panel has ${dp.steps.length}; OG's row still has ${deep.ogSteps.length}`);

    // The four identical ancestors: a path, not repetition.
    phase('disclose', 'press-the-control-on-the-identical-ancestors');
    await pressToggle('same', 'click');
    refs = await readRefs();
    const samePanel = ((groupOf(refs, 'same') || {}).group || {}).panel;
    record('P6.7', 'a path whose ancestors share one text is numbered and ordered',
      !!samePanel && samePanel.steps.length === 1 && samePanel.steps[0].level === '1.' &&
        samePanel.steps[0].text.includes(head(T.sameName)),
      samePanel ? JSON.stringify(samePanel.steps) : 'no panel');

    // ---------- P7 : two panels, independent ----------
    say('\nP7  two panels at once, each its own');
    record('P7.1', 'both panels are open and neither reset the other',
      refs.panels === 2 && !!(groupOf(refs, 'deepA') || {}).group.panel,
      `${refs.panels} panel(s) open`);
    const ids = refs.items.flatMap((i) => i.groups.map((gp) => gp.panel && gp.panel.id))
      .filter(Boolean);
    record('P7.2', 'each panel has its own id, and its own control points at it',
      new Set(ids).size === ids.length && refs.items.every(
        (i) => i.groups.every((gp) => !gp.panel || gp.toggle.controls === gp.panel.id)),
      JSON.stringify(ids));

    phase('disclose', 'close-one-of-two');
    await pressInPanel('same', '.f28-path-hide');
    refs = await readRefs();
    record('P7.3', 'closing one leaves the other exactly as it was',
      refs.panels === 1 && !!(groupOf(refs, 'deepA') || {}).group.panel &&
        !(groupOf(refs, 'same') || {}).group.panel,
      `${refs.panels} panel(s); deep open: ` +
      `${!!(groupOf(refs, 'deepA') || {}).group.panel}`);
    record('P7.4', "the closed group's breadcrumb is back to what OG rendered",
      (() => { const s = (groupOf(refs, 'same') || {}).group;
               return !!s && s.ogSteps.length === D.same.visible &&
                      s.toggle && s.toggle.expanded === 'false'; })(),
      (() => { const s = (groupOf(refs, 'same') || {}).group;
               return s ? `${s.ogSteps.length} OG step(s), expanded=` +
                          `${s.toggle && s.toggle.expanded}` : 'not found'; })());

    // ---------- P8 : deeper than one batch ----------
    say('\nP8  a path deeper than one batch continues rather than lying');
    phase('disclose', 'press-the-control-on-the-14-deep-path');
    await pressToggle('deepest', 'click');
    refs = await readRefs();
    let deepest = ((groupOf(refs, 'deepest') || {}).group || {}).panel;
    observations.deepestFirstPress = deepest;
    const want1 = RG.DEEPEST_PRESSES[0];
    record('P8.1', 'the first press shows one batch and does not claim to be the whole path',
      !!deepest && deepest.steps.length === want1.shows &&
        !/whole path/i.test(deepest.status) && deepest.hasMore === want1.continues &&
        deepest.incomplete.length > 0,
      deepest ? `${deepest.steps.length} step(s), "${deepest.status}", ` +
                `more:${deepest.hasMore}, "${deepest.incomplete}"` : 'no panel');
    record('P8.2', 'an unfinished path is not numbered, because no position is known yet',
      !!deepest && deepest.steps.every((s) => s.level === '') && deepest.pageLine === '',
      deepest ? `levels ${JSON.stringify(deepest.steps.map((s) => s.level))}, ` +
                `page line "${deepest.pageLine}"` : 'no panel');
    record('P8.3', 'the levels it did read are the OUTERMOST it could reach, in order',
      !!deepest && deepest.steps.length > 2 &&
        deepest.steps.every((s, i) => s.text.includes(
          head(RG.DEEPEST_LEVELS[RG.DEEPEST_LEVELS.length - 11 + i]))),
      deepest ? JSON.stringify(deepest.steps.slice(0, 3).map((s) => s.text.slice(0, 22)))
              : 'no panel');

    // The safety property this fixture exists to measure.
    const markupStep = deepest && deepest.steps.find((s) => s.text.includes('{{query'));
    record('P8.4', 'a step is PLAIN TEXT: nothing in the panel is rendered by OG at all',
      !!deepest && deepest.images === 0 && deepest.iframes === 0 &&
        deepest.macros === 0 && deepest.refs === 0,
      deepest ? `${deepest.images} img, ${deepest.iframes} media element(s), ` +
                `${deepest.macros} macro/query container(s), ${deepest.refs} ref element(s)`
              : 'no panel');
    record('P8.5', 'the macro written in that ancestor is on screen as CHARACTERS, not run',
      !!markupStep && markupStep.text.includes('{{query (todo TODO)}}'),
      markupStep ? `"${markupStep.text}"` : 'the ancestor carrying the markup is not shown');
    // Recorded rather than asserted as a requirement: the image markdown is
    // REDUCED to its own alt text by the same compact-label reduction every
    // other F27 label uses. That is not a render — no element is created and no
    // file is requested — but it is worth naming, because the raw `![…](…)` is
    // not what the reader sees.
    observations.imageAncestor = markupStep ? markupStep.text : null;
    record('P8.6', 'a step is not a link either: a panel contains no anchor at all',
      !!deepest && deepest.anchors === 0,
      deepest ? `${deepest.anchors} anchor(s), ${deepest.buttons} button(s)` : 'no panel');

    phase('disclose', 'continue-the-14-deep-path');
    await pressInPanel('deepest', '.f28-path-more');
    refs = await readRefs();
    deepest = ((groupOf(refs, 'deepest') || {}).group || {}).panel;
    observations.deepestSecondPress = deepest;
    const want2 = RG.DEEPEST_PRESSES[1];
    record('P8.7', 'the second press completes the path and withdraws the continuation',
      !!deepest && deepest.steps.length === want2.shows &&
        /whole path/i.test(deepest.status) && deepest.hasMore === false &&
        deepest.pageLine.includes(RG.DEEPEST_PAGE) && deepest.incomplete === '',
      deepest ? `${deepest.steps.length} step(s), "${deepest.status}", ` +
                `page "${deepest.pageLine}"` : 'no panel');
    record('P8.8', 'and it is now numbered from the source page, 1 to 11',
      !!deepest && deepest.steps.map((s) => s.level).join(',') ===
        Array.from({ length: want2.shows }, (_, i) => `${i + 1}.`).join(','),
      deepest ? JSON.stringify(deepest.steps.map((s) => s.level)) : 'no panel');
    record('P8.9', 'the complete disclosure plus OG\'s own row is the whole 14-level path',
      !!deepest &&
        deepest.steps.length + (groupOf(refs, 'deepest') || {}).group.ogSteps.length ===
          D.deepest.depth,
      deepest ? `${deepest.steps.length} disclosed + ` +
                `${(groupOf(refs, 'deepest') || {}).group.ogSteps.length} on the row = ` +
                `${D.deepest.depth}` : 'no panel');

    // ---------- P9 : the keyboard ----------
    say('\nP9  the keyboard, in a window whose global handler eats Enter');
    phase('keyboard', 'operate-the-control-without-a-mouse');
    await pressInPanel('deepest', '.f28-path-hide');
    await pressInPanel('deepA', '.f28-path-hide');
    refs = await readRefs();
    record('P9.1', 'everything is closed before the keyboard cases', refs.panels === 0,
      `${refs.panels} panel(s)`);

    const enterId = await pressToggle('four', 'keyboard-enter');
    refs = await readRefs();
    const fourOpen = !!((groupOf(refs, 'four') || {}).group || {}).panel;
    record('P9.2', 'Enter on a focused control opens the path', fourOpen,
      `${enterId} → ${refs.panels} panel(s)`);
    const focusOk = await page.evaluate((i) => document.activeElement &&
      document.activeElement.id === i, enterId).catch(() => false);
    record('P9.3', 'and focus stays on the control that was pressed', focusOk === true,
      `activeElement is the control: ${focusOk}`);

    await pressToggle('four', 'keyboard-space');
    refs = await readRefs();
    record('P9.4', 'Space on the same control closes it again',
      !((groupOf(refs, 'four') || {}).group || {}).panel && refs.panels === 0,
      `${refs.panels} panel(s) after Space`);

    // ---------- P10 : nothing else changed ----------
    say('\nP10 the rest of the list, after all of that');
    phase('regression', 're-check-og-behaviour');
    await pressToggle('deepA', 'click');
    refs = await readRefs();
    record('P10.1', 'no editor was opened by any control in this run', refs.editors === 0,
      `${refs.editors} editor(s)`);
    record('P10.2', 'nothing navigated', refs.hash === `#/page/${encodeURIComponent(RG.ANCHOR)}`,
      refs.hash);
    record('P10.3', 'the groups, the counts and the section headings are as they started',
      refs.items.length === 4 && refs.heading.includes('11') &&
        [...new Set(refs.items.flatMap((i) => i.groups.flatMap((gp) => gp.blocks)))].length === 11,
      `${refs.items.length} pages, "${refs.heading}"`);

    phase('regression', 'the-filter-over-a-path-the-reader-can-now-open');
    await page.locator('a.filter').first().click({ timeout: 15000 }).catch(() => null);
    await sleep(2500);
    const filterNames = await page.evaluate(() => {
      const m = document.querySelector('.ls-filters, .filters');
      return m ? [...m.querySelectorAll('button')].map((b) => (b.innerText || '').trim())
        .filter(Boolean) : null;
    }).catch(() => null);
    observations.filterOptions = filterNames;
    record('P10.4', 'the filter still offers the pages referenced from inside the source paths',
      !!filterNames && filterNames.some((n) => n.includes('필터 태그')),
      JSON.stringify(filterNames));
    await page.keyboard.press('Escape').catch(() => null);
    await sleep(1500);

    refs = await readRefs();
    record('P10.5', 'the open panel survived the filter dialog',
      !!((groupOf(refs, 'deepA') || {}).group || {}).panel,
      `${refs.panels} panel(s) still open`);

    // Korean and emoji, on screen, in both the row and the panel.
    const textOk = await page.evaluate(() => {
      const sec = document.querySelector('.references.page-linked');
      const t = sec ? sec.innerText : '';
      return { hangul: /[가-힯]/.test(t), emoji: /🎯|🌿|🔗|♻️|📅|🪜/.test(t),
               mojibake: /[�]/.test(t) };
    }).catch(() => null);
    record('P10.6', 'Korean, English and emoji read correctly throughout',
      !!textOk && textOk.hangul && textOk.emoji && !textOk.mojibake,
      JSON.stringify(textOk));

    // ---------- P11 : the right sidebar, a NAMED exclusion ----------
    say('\nP11 the same list in the right sidebar gets nothing at all');
    phase('regression', 'open-the-anchor-page-in-the-right-sidebar');
    await goTo(RG.DEEP_PAGE);
    await sleep(2500);
    await parkPointer();
    // Shift-click the anchor's page link inside a block on this page: OG sends
    // that page to the right sidebar, which renders ITS linked references —
    // the same component, on the surface this feature excludes by name.
    //
    // A REAL click, not a synthesised `mouseup`. `page-inner` guards its
    // mouse-up handler with a React state flag set by `mousedown`, so a lone
    // dispatched event does nothing — which the first run of this check
    // discovered by reporting an empty sidebar.
    let opened = { found: false };
    try {
      await page.locator(`#main-content-container a.page-ref:text-is("${RG.ANCHOR}")`)
        .first().click({ modifiers: ['Shift'], timeout: 20000 });
      opened = { found: true };
    } catch (e) {
      opened = { found: false, error: String(e.message).split('\n')[0] };
    }
    await sleep(6000);
    // The sidebar's own list is lazy too; scroll it rather than assume.
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
      crumbs: document.querySelectorAll('.sidebar-item .breadcrumb').length,
      inertMore: [...document.querySelectorAll('.sidebar-item .breadcrumb span')]
        .filter((x) => (x.innerText || '').trim() === '⋯').length,
      toggles: document.querySelectorAll('.sidebar-item .f28-path-toggle').length,
      panels: document.querySelectorAll('.sidebar-item .f28-path-panel').length,
      wrappers: document.querySelectorAll('.sidebar-item .f28-path').length,
    })).catch(() => null);
    observations.sidebar = sidebar;
    record('P11.1', "the anchor's linked references really are rendered in the right sidebar",
      !!sidebar && sidebar.items > 0 && sidebar.refs > 0 && sidebar.crumbs > 0,
      JSON.stringify(sidebar) + ` (shift-click found the link: ${opened.found})`);
    record('P11.2', 'and they carry NO control, no panel and no wrapper — an excluded surface',
      !!sidebar && sidebar.toggles === 0 && sidebar.panels === 0 && sidebar.wrappers === 0,
      sidebar ? `${sidebar.toggles} control(s), ${sidebar.panels} panel(s), ` +
                `${sidebar.wrappers} wrapper(s)` : 'no reading');
    record('P11.3', "OG's own inert marker is still there instead, exactly as it was",
      !!sidebar && sidebar.inertMore > 0,
      sidebar ? `${sidebar.inertMore} "⋯" marker(s) in the sidebar's breadcrumbs` : 'no reading');
  } finally {
    // The structured evidence the error rule needs, taken while the window is
    // still there. A run that could not collect it pairs NOTHING, which is the
    // direction this must fail in.
    errorEvidence = await session.collectErrorEvidence();
    const closed = await APP.close(session, { say });
    record('P11.9', 'every owned process stopped, addressed by retained PID only',
      closed.stillAlive.length === 0,
      `${ownedTree.length} process(es) owned at launch (pids ${ownedTree.join(', ')}), ` +
      `stage ${closed.stage}` +
      (closed.stillAlive.length ? `, still alive: ${closed.stillAlive.join(', ')}`
                                : ', none still alive'));
  }

  // ---------- P12 : the graph, afterwards ----------
  say('\nP12 the graph, after the application closed');
  errors.endPhase();

  const after = GH.snapshot(GRAPH);
  const cmp = GH.compare(before, after);
  record('P12.1', 'no content file changed: the disclosure only ever read',
    cmp.content.length === 0,
    cmp.content.length ? JSON.stringify(cmp.content.map((c) => `${c.change} ${c.file}`))
                       : `0 content changes across ${cmp.afterCount} files`);
  const controlAfter = after[RG.CONTROL_FILE];
  record('P12.2', 'the control page is byte-identical',
    !!controlAfter && !!controlBefore && controlAfter.sha256 === controlBefore.sha256,
    controlAfter ? `${controlAfter.sha256.slice(0, 16)}…, unchanged` : 'missing');
  record('P12.3', 'OG housekeeping is recorded separately rather than counted as content', true,
    cmp.housekeeping.length
      ? `${cmp.housekeeping.length}: ` +
        cmp.housekeeping.map((c) => `${c.change} ${c.file}`).slice(0, 6).join('; ')
      : 'none');

  const cls = EC.summarise(errors.entries(),
    { outsidePath: BAD, graphPath: GRAPH, phases: errors.phases() });
  const split = NOISE.partition(cls.unexpected, errors.entries(), errorEvidence);
  // RAW evidence first, and unconditionally: every captured line, every window
  // ErrorEvent, and the rule's own accounting. Classification is recorded
  // beside it, never instead of it.
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
  for (const line of EC.describe(cls.expected)) say(`          expected:   ${line}`);
  for (const line of EC.describe(split.noise, 3)) say(`          pre-existing: ${line}`);
  for (const r of split.refused.slice(0, 5)) {
    say(`          REFUSED BY THE RULE: ${r.refusedBecause}\n            ` +
        `${String(r.text).slice(0, 160)}`);
  }
  for (const line of EC.describe(split.remaining, 5)) say(`          UNEXPECTED: ${line}`);
  record('P12.4', 'every window error was entitled, once one pre-existing browser notice is named',
    split.remaining.length === 0,
    `${errors.entries().length} captured across ${JSON.stringify(cls.byPhase)}; ` +
    `${cls.expected.length} expected, ${split.noise.length} exempted, ` +
    `${split.refused.length} handler line(s) refused by the rule, ` +
    `${split.remaining.length} unexplained` +
    (split.remaining.length ? `: ${EC.describe(split.remaining, 1)[0]}` : ''));
  record('P12.7', 'the exemption rule was armed with the evidence it requires',
    split.evidence.collected === true,
    split.evidence.collected
      ? `${split.evidence.windowErrorEvents} window ErrorEvent(s) collected, ` +
        `${split.evidence.nullPayloadNotices} of them null-payload ResizeObserver notice(s); ` +
        `${split.evidence.pairsClaimed} pair(s) claimed`
      : "the page's ErrorEvent log could not be collected, so NO handler line could be " +
        'exempted (this is the direction the rule fails in, not a pass)');
  record('P12.5', 'nothing that unmounts a React subtree was thrown',
    cls.renderFailures.length === 0,
    cls.renderFailures.length ? String(cls.renderFailures[0].text).slice(0, 250)
                              : `0 render failures among ${errors.entries().length} line(s)`);
  const duringFeature = errors.entries().filter(
    (e) => e.phase === 'disclose' || e.phase === 'keyboard');
  record('P12.6', 'no error at all arrived while the disclosure was being operated',
    duringFeature.length === 0,
    duringFeature.length ? `${duringFeature.length}: ${duringFeature[0].text.slice(0, 200)}`
                         : '0 during the disclose and keyboard phases');

  const failed = results.filter((r) => !r.ok);
  fs.writeFileSync(path.join(EVIDENCE, 'f28-refpath-feature-observations.json'),
    JSON.stringify({ graph: GRAPH, observations }, null, 2));
  fs.writeFileSync(path.join(EVIDENCE, 'f28-refpath-feature-summary.json'),
    JSON.stringify({ at: new Date().toISOString(), app: built.appDir, graph: GRAPH,
                     passed: results.length - failed.length, failed: failed.length, results },
                   null, 2));
  say(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`);
  for (const f of failed) say(`  FAILED ${f.id} ${f.title}\n      ${f.detail}`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => {
  say('\n' + String((e && e.stack) || e) + '\n');
  try {
    fs.mkdirSync(EVIDENCE, { recursive: true });
    fs.writeFileSync(path.join(EVIDENCE, 'f28-refpath-feature-summary.json'),
      JSON.stringify({ at: new Date().toISOString(),
                       aborted: String((e && e.message) || e), results }, null, 2));
    fs.writeFileSync(path.join(EVIDENCE, 'f28-refpath-feature-observations.json'),
      JSON.stringify({ aborted: String((e && e.message) || e), observations,
                       errors: errors.entries() }, null, 2));
  } catch (x) { /* nothing further to do */ }
  process.exitCode = 2;
});
