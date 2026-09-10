#!/usr/bin/env node
'use strict';
//
// DIAGNOSTIC PROBE — not an acceptance check, and not part of any run's
// evidence. It exists to answer ONE question the combined workflow's third run
// left open: the F28 source-path controls are present when the anchor page
// renders as the home page, and absent after the session leaves the page and
// returns. This probe isolates that variable — nothing else runs — and prints
// what OG actually draws on each view:
//
//   V1  the anchor page as the application's home page (the first view);
//   V2  after a plain page round-trip (another page, then back by name);
//   V3  after a block-scoped route (the source control's landing), then back.
//
// For each view it reports, per source-page group: whether the `.f28-path`
// holder exists at all (the surface rules), and whether OG's own breadcrumb
// elided (the `⋯` marker that earns the toggle) — so "the holder is not
// offered" and "the path is not elided" are two visibly different facts.
//
// Same guards, same fresh synthetic graph, same packaged build as the
// scenario; read-only throughout (no API calls, no filter clicks).
//
const path = require('path');
const fs = require('fs');

const REPO = path.resolve(__dirname, '..', '..');
const FEATURE_DIR = path.resolve(__dirname, '..');
const B = require(path.join(REPO, 'f27-pilot', 'checks', 'allowed-root.js'));
const CG = require('./make-combined-graph.js');
const APP = require('./packaged-app.js');
const REC = require('./recorder.js');
const RD = require('./reforder-read.js');

const FEATURE_APP = 'Logseq-OG-F28-RefPath';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function say(l) { try { fs.writeSync(1, l + '\n'); } catch (e) { console.log(l); } }

(async () => {
  const built = APP.resolve(FEATURE_APP);
  if (!built.preflight.ok) throw new Error('preflight failed');
  const g = CG.build({ kind: 'probe' });
  const GRAPH = B.assertInsideAllowedRoot('probe graph', g.graph);
  const BAD = path.join(path.dirname(B.allowedRootReal()), 'f28-combined-probe-inert');
  const errors = REC.createRecorder();
  const record = (id, title, ok, detail) =>
    say(`  ${ok ? 'PASS' : 'FAIL'}  ${id}  ${title}\n          ${detail}`);
  const phase = (name, op) => errors.phase(name, op);
  const session = await APP.open({
    built, graph: GRAPH, bad: BAD, errors, say, record, phase, prefix: 'P',
  });
  const { page, goTo, parkPointer } = session;
  const settle = RD.makeSettle(page, session, say);
  const U = CG.UUID;

  const diag = (appleUuid) => page.evaluate((uuid) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const sec = document.querySelector('.references.page-linked');
    if (!sec) return { present: false, hash: location.hash };
    const appleRow = (() => {
      const all = [...sec.querySelectorAll('.ls-block[blockid]')];
      const r = sec.querySelector(`.ls-block[blockid="${uuid}"]`);
      const byEq = all.find((e) => e.getAttribute('blockid') === uuid) || null;
      const h = byEq ? byEq.querySelector('.f28-path') : null;
      return { received: uuid == null ? null : String(uuid),
               rowPresent: !!r, byEquality: !!byEq,
               holderInsideRow: !!h,
               elided: !!(h && h.innerText.includes('⋯')) };
    })();
    const toggleIds = [...sec.querySelectorAll('.f28-path-toggle')]
      .map((t) => t.id);
    const holders = [...sec.querySelectorAll('.f28-path')];
    const holderView = holders.map((h) => {
      const bc = h.querySelector(':scope > .breadcrumb');
      const tg = h.querySelector('.f28-path-toggle');
      const row = h.closest('.ls-block[blockid]');
      return { crumb: clean(bc ? bc.innerText : '').slice(0, 90),
               elided: !!(bc && bc.innerText.includes('⋯')),
               toggle: !!tg,
               expanded: tg ? tg.getAttribute('aria-expanded') : null,
               rowId: row ? row.getAttribute('blockid') : null,
               holdsInside: [...h.querySelectorAll('.ls-block[blockid]')]
                 .map((e) => e.getAttribute('blockid')).length };
    });
    // Every breadcrumb in the section, including any drawn without a holder.
    const crumbs = [...sec.querySelectorAll('.breadcrumb')].map((bc) => ({
      crumb: clean(bc.innerText).slice(0, 90),
      elided: bc.innerText.includes('⋯'),
      wrapped: !!(bc.parentElement && bc.parentElement.classList.contains('f28-path')),
    }));
    const groups = [...sec.querySelectorAll('.custom-query-page-result, .references-blocks-item')]
      .map((el) => clean(el.querySelector('.page-title, a.page-ref') ? el.querySelector('.page-title, a.page-ref').innerText : '').slice(0, 40));
    const sel = document.querySelector('select.f28-order-select');
    const rowDump = [...sec.querySelectorAll('.ls-block[blockid]')].map((r) => ({
      id: r.getAttribute('blockid'),
      t: clean(r.innerText).slice(0, 50),
    }));
    return {
      present: true,
      hash: location.hash,
      rows: sec.querySelectorAll('.ls-block[blockid]').length,
      rowDump,
      holders: holderView.length,
      holderView,
      appleRow,
      toggleIds,
      crumbs,
      crumbsElided: crumbs.filter((c) => c.elided).length,
      unwrappedElided: crumbs.filter((c) => c.elided && !c.wrapped).length,
      groupHeaders: groups,
      select: sel ? sel.value : null,
      ctxControls: sec.querySelectorAll('.f28-ctx-open').length,
    };
  }, appleUuid).catch((e) => ({ error: String(e.message) }));

  const show = async (label) => {
    const d = await diag(U.appleRef);
    say(`\n[${label}]`);
    say(JSON.stringify(d, null, 1));
    return d;
  };

  try {
    await settle('V1: the anchor page as home');
    const v1 = await show('V1 initial view (home page)');

    await goTo(CG.BADGE_PAGE);
    await goTo(CG.ANCHOR);
    await settle('V2: after a plain page round-trip');
    const v2 = await show('V2 after page round-trip');

    await page.evaluate((id) => { location.hash = '#/page/' + id; }, U.badgeHost);
    await sleep(3500);
    const blockView = await diag(U.appleRef);
    say('\n[V3a block-scoped route]');
    say(JSON.stringify({ present: blockView.present, hash: blockView.hash }));
    await goTo(CG.ANCHOR);
    await settle('V3: after the block-scoped route, back by name');
    const v3 = await show('V3 after block-route then back');

    say('\n[summary]');
    say(`V1: holders ${v1.holders}, elided crumbs ${v1.crumbsElided}, unwrapped-elided ${v1.unwrappedElided}, ctx ${v1.ctxControls}, select ${v1.select}`);
    say(`V2: holders ${v2.holders}, elided crumbs ${v2.crumbsElided}, unwrapped-elided ${v2.unwrappedElided}, ctx ${v2.ctxControls}, select ${v2.select}`);
    say(`V3: holders ${v3.holders}, elided crumbs ${v3.crumbsElided}, unwrapped-elided ${v3.unwrappedElided}, ctx ${v3.ctxControls}, select ${v3.select}`);
  } finally {
    await APP.close(session, { say });
  }
})().catch((e) => { say(`\nPROBE FAILED: ${e.stack || e.message}`); process.exitCode = 1; });