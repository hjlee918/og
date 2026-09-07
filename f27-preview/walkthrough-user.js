'use strict';
//
// The five guided actions of the ORIGINAL user preview, against the original
// user demonstration graph (`f27-preview-demo`).
//
// It is kept so the earlier walkthrough and its guide stay runnable:
// `node f27-preview/preview.js --demo user --self-check`. The integrated
// preview's own scenario is in `walkthrough-integrated.js`.
//
// Two things in it had gone stale and were repaired here, both in the SCRIPT
// and neither in the application. Running it on 2026-09-07 is what found them,
// and the last recorded run before that was 2026-09-06, 15/15:
//
//   * the readable-context batch REPEATS collapse / Back / Show-children at the
//     end of long content (checklist A18), so a bare locator now matches two
//     buttons and Playwright refuses to guess. Each is `.first()` now.
//   * the same batch shortened the inbound direction sentence from "refer TO
//     the selected block. They are not links written inside it…" to "refer TO
//     this one — not links inside it, and not its children." The assertion
//     accepts either wording rather than pinning the current one.
const path = require('path');

// Maintenance walkthrough — the five actions the guide asks the reader to do,
// performed against this same launch path so the guide can be trusted.
// ---------------------------------------------------------------------------
async function walkthroughUser(page, out, ctx) {
  const sleep = ctx.sleep;
  const checks = out.checks;
  const check = (id, ok, detail) => {
    checks.push({ id, result: ok ? 'PASS' : 'FAIL', detail });
    ctx.log(`  [${ok ? 'PASS' : 'FAIL'}] ${id} — ${detail}`);
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
    await row(i).locator('.f27-ctx-toggle').first().click();
    await sleep(1200);
  };
  const openInbound = async (i) => {
    await away();
    await row(i).locator('.f27-in-toggle').first().click();
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
  await page.locator('.f27-crystal-config-toggle').first().click();
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
  await page.locator('.f27-crystal-clear').first().click().catch(() => {});
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
  await row(iRev).locator('.f27-desc-toggle-all').first().click();
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
    !!lvl1 && /refer TO the selected block|refer TO this one/.test(lvl1.direction),
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
  await row(iKo).locator('.f27-in-back').first().click();
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

  await page.screenshot({ path: path.join(ctx.previewDir, 'preview-walkthrough.png') }).catch(() => {});
}


module.exports = { walkthroughUser };
