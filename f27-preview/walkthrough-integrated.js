'use strict';
//
// The consolidated scenario for the INTEGRATED demonstration graph.
//
// It is one pass over a single reference panel, in the order the English guide
// asks a reader to work through it, and it doubles as this batch's acceptance
// smoke: every accepted F27 slice is exercised on the same notes, and a
// selection of the safety boundaries earlier batches closed is re-asserted on
// the way past.
//
//   PART 1  the compact overview — nine sources, their breadcrumbs, no
//           identifiers in the reading view
//   PART 2  the Crystal marker — chosen from the graph's real tags, previewed,
//           cleared
//   PART 3  ancestors and children of one reference
//   PART 4  following inbound references, and Back
//   PART 5  a cycle, stopped and explained
//   PART 6  a genuine "nothing references this"
//   PART 7  pictures and attachments — bounded, named, never played, and with
//           no editing affordance anywhere near them
//   PART 8  a block embed, read in place and collapsed again
//   PART 9  a page embed, read as a bounded excerpt, then extended and closed
//   PART 10 safety regressions: a path that climbs out of the graph, a picture
//           on the web, a query, a remote player, raw markup, the bounded
//           preview budget, and the mutual pair that used to recurse
//   PART 11 the keyboard, on the control this batch's demo adds
//
// It clicks only F27's own controls, opens no editor, and asserts at the end
// that no panel caused a network request.
const path = require('path');

// Local schemes the application uses to reach its OWN files. `assets:` is how
// OG serves a graph-local asset, so it is not a fetch of anything remote.
const LOCAL = /^(devtools|file|data|blob|chrome|assets|asset|about):/i;

// The phases in which a reference PANEL was the thing on screen. OG's own
// startup, and the ordinary page rendering around a panel, are its own
// behaviour and are reported rather than swept up.
const PANEL_PHASES = new Set([
  'overview', 'crystal', 'context', 'inbound', 'cycle', 'empty',
  'assets', 'embed', 'excerpt', 'refusals', 'keyboard',
]);

async function walkthroughIntegrated(page, out, ctx) {
  const sleep = ctx.sleep;
  const demo = ctx.demo; // the generator module, for the names it wrote
  const checks = out.checks;
  const check = (id, ok, detail) => {
    checks.push({ id, result: ok ? 'PASS' : 'FAIL', detail });
    ctx.log(`  [${ok ? 'PASS' : 'FAIL'}] ${id} — ${detail}`);
  };
  const phase = (name) => {
    ctx.setPhase(name);
  };

  // --- small helpers, all reading what a reader would see -------------------
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
  const openCtx = async (i) => {
    await away();
    await row(i).locator('.f27-ctx-toggle').first().click();
    await sleep(1500);
  };
  const ensureCtx = async (i) => {
    if ((await row(i).locator('.f27-ctx').count()) === 0) await openCtx(i);
  };
  const openInbound = async (i) => {
    await away();
    await row(i).locator('.f27-in-toggle').first().click();
    await sleep(1700);
  };

  // Everything one row's inbound panel put on screen.
  const inItems = (i) =>
    page.evaluate((n) => {
      const r = document.querySelectorAll('.f27-ref-row')[n];
      const body = r && r.querySelector('.f27-in-body');
      const txt = (e) => ((e && e.innerText) || '').trim();
      if (!body) return null;
      return {
        head: txt(body.querySelector('.f27-in-head')),
        direction: txt(body.querySelector('.f27-in-direction')),
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

  // Everything one row's CONTEXT put on screen, as a reader sees it.
  const ctxOf = (i) =>
    page.evaluate((i) => {
      const r = document.querySelectorAll('.f27-ref-row')[i];
      const c = r && r.querySelector('.f27-ctx');
      if (!c) return null;
      const txt = (e) => ((e && e.innerText) || '').trim();
      const gsize = (t) => {
        if (!t) return 0;
        try {
          return Array.from(new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(t)).length;
        } catch (e) {
          return Array.from(t).length;
        }
      };
      const assetOf = (a) => {
        const img = a.parentElement && a.parentElement.querySelector('.f27-asset-img');
        const box = img ? img.getBoundingClientRect() : null;
        return {
          cls: (a.className || '').toString(),
          badge: txt(a.querySelector('.f27-ctx-badge.is-asset')),
          name: txt(a.querySelector('.f27-asset-name')),
          missing: txt(a.querySelector('.f27-asset-missing')),
          mark: txt(a.querySelector('.f27-asset-mark')),
          open: !!a.querySelector('.f27-asset-open'),
          title: a.getAttribute('title'),
          thumb: img ? { w: Math.round(box.width), h: Math.round(box.height), src: (img.getAttribute('src') || '').slice(0, 12) } : null,
        };
      };
      const inertOf = (e) => ({
        cls: (e.className || '').toString(),
        badge: txt(e.querySelector('.f27-ctx-badge.is-inert')),
        mark: txt(e.querySelector('.f27-inert-mark')),
        text: txt(e.querySelector('.f27-inert-text')),
        missing: txt(e.querySelector('.f27-inert-missing')),
        toggle: !!e.querySelector('.f27-embed-toggle'),
        expanded: (e.querySelector('.f27-embed-toggle') || {}).getAttribute
          ? e.querySelector('.f27-embed-toggle').getAttribute('aria-expanded')
          : null,
        pageOpen: !!e.querySelector('.f27-inert-open'),
        blockSource: !!e.querySelector('.f27-body-ref-src'),
        elementsFromMarkup: e.querySelectorAll('b, strong, i, em, img, iframe').length,
      });
      const excerptRow = (e) => ({
        text: txt(e.querySelector('.f27-embed-text')),
        size: gsize(txt(e.querySelector('.f27-embed-text'))),
        cut: !!e.querySelector('.f27-embed-cut'),
        note: txt(e.querySelector('.f27-embed-note')),
        children: txt(e.querySelector('.f27-page-embed-children')),
        badges: Array.from(e.querySelectorAll('.f27-ctx-badge')).map(txt),
        assets: Array.from(e.querySelectorAll('.f27-asset')).map(assetOf),
        refs: Array.from(e.querySelectorAll('.f27-body-ref')).map((x) => ({
          mark: txt(x.querySelector('.f27-body-ref-mark')),
          text: txt(x.querySelector('.f27-body-ref-text')),
        })),
        imgs: e.querySelectorAll('img').length,
      });

      return {
        text: txt(c),
        ancestors: Array.from(c.querySelectorAll('.f27-ctx-lines .f27-ctx-line')).map(txt),
        children: Array.from(c.querySelectorAll('.f27-desc-line')).map(txt),
        childBadges: Array.from(c.querySelectorAll('.f27-desc-line .f27-ctx-badge')).map(txt),
        childEmphasis: c.querySelectorAll('.f27-desc-line b, .f27-desc-line strong').length,
        assets: Array.from(c.querySelectorAll('.f27-asset')).map(assetOf),
        inert: Array.from(c.querySelectorAll('.f27-inert')).map(inertOf),
        embeds: Array.from(c.querySelectorAll('.f27-inert.is-embed:not(.is-page)')).map(inertOf),
        pageEmbeds: Array.from(c.querySelectorAll('.f27-inert.is-embed.is-page')).map(inertOf),
        expansions: Array.from(c.querySelectorAll('.f27-embed-body')).map((b) => ({
          text: txt(b.querySelector('.f27-embed-text')),
          size: gsize(txt(b.querySelector('.f27-embed-text'))),
          note: txt(b.querySelector('.f27-embed-note')),
          collapse: !!b.querySelector('.f27-embed-collapse'),
          refs: Array.from(b.querySelectorAll('.f27-body-ref')).map((x) => ({
            mark: txt(x.querySelector('.f27-body-ref-mark')),
            text: txt(x.querySelector('.f27-body-ref-text')),
            src: !!x.querySelector('.f27-body-ref-src'),
          })),
          assets: Array.from(b.querySelectorAll('.f27-asset')).map(assetOf),
          imgs: b.querySelectorAll('img').length,
        })),
        excerpts: Array.from(c.querySelectorAll('.f27-page-embed-body')).map((b) => ({
          title: txt(b.querySelector('.f27-page-embed-title')),
          limits: txt(b.querySelector('.f27-page-embed-limits')),
          rows: Array.from(b.querySelectorAll('.f27-page-embed-row')).map(excerptRow),
          notes: Array.from(b.querySelectorAll(':scope > .f27-embed-note')).map(txt),
          more: !!b.querySelector('.f27-page-embed-more'),
          collapse: !!b.querySelector('.f27-embed-collapse'),
        })),
        previews: Array.from(c.querySelectorAll('.f27-body-ref.is-preview')).map((e) => ({
          size: gsize(txt(e.querySelector('.f27-body-ref-text'))),
          cut: !!e.querySelector('.f27-body-ref-cut'),
        })),
        bodyNote: txt(c.querySelector('.f27-body-note')),
        // Anything OG's own renderers would have produced inside a panel.
        og: {
          assetContainers: c.querySelectorAll('.asset-container').length,
          actionBars: c.querySelectorAll('.asset-action-bar').length,
          resizers: c.querySelectorAll('.resize, .resizer, [class*="resizable"]').length,
          embeds: c.querySelectorAll('.embed-block, .embed-page, .block-embed, .page-embed, .custom-query, .page-blocks-inner, .block-children').length,
          iframes: c.querySelectorAll('iframe').length,
          audio: c.querySelectorAll('audio').length,
          video: c.querySelectorAll('video').length,
          warnings: Array.from(c.querySelectorAll('.warning')).map(txt),
          editors: c.querySelectorAll('textarea').length,
        },
        imgSrcs: Array.from(c.querySelectorAll('img')).map((im) => (im.getAttribute('src') || '').slice(0, 60)),
      };
    }, i);

  // =========================================================================
  // PART 1 — the compact overview
  // =========================================================================
  phase('overview');
  await page.evaluate(() => {
    location.hash = '#/page/' + encodeURIComponent('Deep Work');
  });
  await sleep(3500);
  if ((await page.locator('.f27-ref-overview').count()) === 0) {
    await page.locator('a.open-block-ref-link').first().click();
    await sleep(2600);
  }
  const crumbs = await rows();
  out.overview_rows = crumbs;
  const want = [
    'Weekly Review', '연구 노트', 'Habit Loop', 'Quick Capture',
    'Field Notes', 'Attachments', 'Reading List', 'Study Plan', 'Link Check',
  ];
  const found = want.filter((w) => crumbs.some((c) => c.includes(w)));
  check(
    'overview-lists-every-source-with-its-own-breadcrumb',
    crumbs.length === want.length && found.length === want.length,
    `${crumbs.length} row(s), ${found.length}/${want.length} expected sources: ${JSON.stringify(crumbs)}`
  );

  const leak = await page.evaluate(() => {
    const p = document.querySelector('.f27-ref-overview');
    const t = (p && p.innerText) || '';
    return { id: /id::/.test(t), uuid: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(t) };
  });
  out.overview_leak = leak;
  check(
    'the-overview-keeps-identifiers-out-of-the-reading-view',
    !leak.id && !leak.uuid,
    `"id::" visible = ${leak.id}; a raw identifier visible = ${leak.uuid}`
  );

  // =========================================================================
  // PART 2 — the Crystal marker
  // =========================================================================
  phase('crystal');
  await away();
  await page.locator('.f27-crystal-config-toggle').click();
  await sleep(1000);
  const options = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.f27-crystal-option')).map((o) => (o.innerText || '').trim())
  );
  out.crystal_options = options;
  const coreIdx = options.findIndex((o) => o.includes('핵심'));
  check(
    'the-marker-list-offers-the-graphs-own-tags',
    coreIdx >= 0 && options.some((o) => o.includes('question')) && options.some((o) => o.includes('자료')),
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
    'the-chosen-marker-previews-beside-the-references-and-states-its-scope',
    withMarker.chips.length >= 2 && withMarker.scope && /Crystal marker:/.test(withMarker.toggle),
    `${withMarker.chips.length} preview(s) ${JSON.stringify(withMarker.chips)}; toggle = ${JSON.stringify(withMarker.toggle)}`
  );
  await away();
  await page.locator('.f27-crystal-clear').click().catch(() => {});
  await sleep(1400);
  const cleared = await page.evaluate(() => document.querySelectorAll('.f27-crystal-chip').length);
  check('the-marker-can-be-cleared-again', cleared === 0, `preview chips after clearing = ${cleared}`);

  // =========================================================================
  // PART 3 — ancestors and children
  // =========================================================================
  phase('context');
  const iRev = await rowIdx('Weekly Review');
  await openCtx(iRev);
  const rev = await ctxOf(iRev);
  out.weekly_review = rev;
  check(
    'the-ancestor-path-above-the-reference-is-shown',
    !!rev &&
      rev.ancestors.some((a) => a.includes('Weekly review')) &&
      rev.ancestors.some((a) => a.includes('Week 36')) &&
      rev.ancestors.some((a) => a.includes('What worked')),
    `${rev ? rev.ancestors.length : 0} line(s): ${JSON.stringify(rev && rev.ancestors)}`
  );
  await away();
  await row(iRev).locator('.f27-desc-toggle-all').click();
  await sleep(1600);
  const revKids = await ctxOf(iRev);
  out.weekly_review_children = { lines: revKids.children, badges: revKids.childBadges, emphasis: revKids.childEmphasis };
  check(
    'the-children-of-that-reference-are-shown-on-request-with-their-markers',
    revKids.children.length >= 4 &&
      revKids.children.some((c) => c.includes('Keep the same two hours')) &&
      revKids.childBadges.some((b) => /TODO/.test(b)) &&
      revKids.childEmphasis > 0,
    `${revKids.children.length} child line(s); badges = ${JSON.stringify(revKids.childBadges)}; ` +
      `emphasis elements = ${revKids.childEmphasis}`
  );
  await openCtx(iRev); // close it again

  // =========================================================================
  // PART 4 — following inbound references, and Back
  // =========================================================================
  phase('inbound');
  const iKo = await rowIdx('연구 노트');
  await openCtx(iKo);
  await openInbound(iKo);
  const lvl1 = await inItems(iKo);
  out.chain_level_1 = lvl1;
  check(
    'the-first-step-shows-what-references-the-korean-note',
    !!lvl1 && lvl1.items.length === 1 && lvl1.items[0].crumb.includes('프로젝트 계획'),
    `items = ${JSON.stringify(lvl1 && lvl1.items.map((i) => i.crumb))}`
  );
  check(
    'the-direction-of-the-list-is-stated-in-words',
    !!lvl1 && /refer TO the selected block|refer TO this one/.test(lvl1.direction),
    JSON.stringify(lvl1 && lvl1.direction)
  );
  await away();
  await row(iKo).locator('.f27-in-item').nth(0).locator('.f27-in-explore').click();
  await sleep(1900);
  const lvl2 = await inItems(iKo);
  out.chain_level_2 = lvl2;
  check(
    'a-second-step-shows-what-references-the-plan-and-records-the-path',
    !!lvl2 && lvl2.items.length === 1 && lvl2.items[0].crumb.includes('회의 기록') && lvl2.path.length >= 1,
    `path = ${JSON.stringify(lvl2 && lvl2.path)}; items = ${JSON.stringify(lvl2 && lvl2.items.map((i) => i.crumb))}`
  );
  await away();
  await row(iKo).locator('.f27-in-back').first().click();
  await sleep(1600);
  const backTo = await inItems(iKo);
  out.chain_back = backTo;
  check(
    'back-returns-to-the-previous-step-exactly',
    !!backTo && backTo.items.length === 1 && backTo.items[0].crumb.includes('프로젝트 계획'),
    `after Back: ${JSON.stringify(backTo && backTo.items.map((i) => i.crumb))}`
  );
  await openCtx(iKo);

  // =========================================================================
  // PART 5 — a cycle, stopped and explained
  // =========================================================================
  phase('cycle');
  const iCue = await rowIdx('Habit Loop');
  await openCtx(iCue);
  await openInbound(iCue);
  const cyc1 = await inItems(iCue);
  out.cycle_level_1 = cyc1;
  check(
    'routine-is-listed-as-referencing-habit-loop',
    !!cyc1 && cyc1.items.length === 1 && cyc1.items[0].crumb.includes('Routine'),
    JSON.stringify(cyc1 && cyc1.items.map((i) => i.crumb))
  );
  await away();
  await row(iCue).locator('.f27-in-item').nth(0).locator('.f27-in-explore').click();
  await sleep(1900);
  const cyc2 = await inItems(iCue);
  out.cycle_level_2 = cyc2;
  const boundary = cyc2 && cyc2.items.find((i) => i.crumb.includes('Habit Loop'));
  check(
    'the-return-to-habit-loop-is-marked-a-boundary-and-not-reopened',
    !!boundary && boundary.stop === true && boundary.explore === false,
    boundary
      ? `marker = ${JSON.stringify(boundary.mark)}, next-step control offered = ${boundary.explore}`
      : `rows = ${JSON.stringify(cyc2 && cyc2.items.map((i) => i.crumb))}`
  );
  // The runaway substitution this project already fixed, re-asserted here.
  const cueCtx = await ctxOf(iCue);
  out.cycle_ctx = { warnings: cueCtx.og.warnings, previews: cueCtx.previews };
  check(
    'the-mutual-pair-is-previewed-once-and-never-recursively',
    cueCtx.og.warnings.length === 0 && !/nesting is too deep/i.test(cueCtx.text),
    `OG depth warnings inside the panel = ${cueCtx.og.warnings.length} ${JSON.stringify(cueCtx.og.warnings)}`
  );
  await openCtx(iCue);

  // =========================================================================
  // PART 6 — a genuine "nothing references this"
  // =========================================================================
  phase('empty');
  const iQuick = await rowIdx('Quick Capture');
  await openCtx(iQuick);
  await openInbound(iQuick);
  const empty = await inItems(iQuick);
  out.empty_answer = empty;
  check(
    'a-block-nothing-references-says-so-plainly',
    !!empty && empty.items.length === 0 && empty.notes.some((n) => /No block in this graph references this one/.test(n)),
    JSON.stringify(empty && empty.notes)
  );
  await openCtx(iQuick);

  // =========================================================================
  // PART 7 — pictures and attachments
  // =========================================================================
  phase('assets');
  const iField = await rowIdx('Field Notes');
  await openCtx(iField);
  await sleep(1500);
  const field = await ctxOf(iField);
  out.field_notes = field;
  const chart = field.assets.find((a) => a.name === demo.CHART);
  check(
    'a-picture-stored-in-the-graph-is-shown-at-a-size-that-does-not-bury-the-text',
    !!chart && !!chart.thumb && chart.thumb.h > 0 && chart.thumb.h <= 170 && chart.badge === 'PNG' && chart.open,
    chart
      ? `${chart.name} (${chart.badge}) renders ${chart.thumb ? chart.thumb.w + '×' + chart.thumb.h : 'no thumbnail'} ` +
        `from a 1200×900 file; reveal control = ${chart.open}`
      : `no asset named ${demo.CHART}; assets = ${JSON.stringify(field.assets.map((a) => a.name))}`
  );
  const koShots = field.assets.filter((a) => a.name === demo.KO_IMG);
  check(
    'a-korean-spaced-filename-reads-the-same-written-plainly-or-encoded',
    koShots.length === 2 && koShots.every((a) => a.thumb && a.thumb.h > 0),
    `${koShots.length} chip(s) named ${JSON.stringify(demo.KO_IMG)}; thumbnails = ` +
      JSON.stringify(koShots.map((a) => a.thumb && a.thumb.w + '×' + a.thumb.h))
  );
  const gone = field.assets.find((a) => a.name === demo.GONE);
  check(
    'a-file-that-is-not-on-disk-says-so-and-offers-no-control',
    !!gone && /is-missing/.test(gone.cls) && /file not found/.test(gone.missing) && gone.open === false,
    gone ? `${gone.mark} ${gone.name} ${gone.missing}; reveal control = ${gone.open}` : 'the missing-file chip was not found'
  );
  check(
    'no-og-editing-affordance-reaches-a-panel',
    field.og.assetContainers === 0 && field.og.actionBars === 0 && field.og.resizers === 0 && field.og.editors === 0,
    `asset containers = ${field.og.assetContainers}, action bars = ${field.og.actionBars}, ` +
      `resize handles = ${field.og.resizers}, editors = ${field.og.editors}`
  );

  const iAtt = await rowIdx('Attachments');
  await openCtx(iField); // close the pictures first, so the panel stays short
  await openCtx(iAtt);
  await sleep(1200);
  const att = await ctxOf(iAtt);
  out.attachments = att;
  const badges = att.assets.map((a) => a.badge);
  check(
    'a-pdf-a-document-and-an-audio-file-are-named-never-opened-and-never-played',
    badges.includes('PDF') && badges.includes('DOCX') && badges.includes('MP3') &&
      att.assets.every((a) => a.open === true) &&
      att.og.audio === 0 && att.og.video === 0 && att.og.iframes === 0 &&
      att.imgSrcs.length === 0,
    `badges = ${JSON.stringify(badges)}; names = ${JSON.stringify(att.assets.map((a) => a.name))}; ` +
      `players on screen = ${att.og.audio + att.og.video + att.og.iframes}; images = ${att.imgSrcs.length}`
  );
  await openCtx(iAtt);

  // =========================================================================
  // PART 8 — a block embed, read in place
  // =========================================================================
  phase('embed');
  const iRead = await rowIdx('Reading List');
  await openCtx(iRead);
  await sleep(1200);
  const closedEmbed = await ctxOf(iRead);
  out.embed_closed = closedEmbed;
  const chip = closedEmbed.embeds[0];
  check(
    'a-block-embed-starts-as-the-name-and-source-control-it-already-was',
    !!chip && chip.badge === '{{embed}}' && chip.toggle && chip.expanded === 'false' &&
      chip.blockSource && closedEmbed.expansions.length === 0,
    `chip badge = ${JSON.stringify(chip && chip.badge)}; expand control = ${!!(chip && chip.toggle)} ` +
      `(aria-expanded=${chip && chip.expanded}); source control = ${chip && chip.blockSource}; ` +
      `expansions on screen = ${closedEmbed.expansions.length}`
  );
  await away();
  await row(iRead).locator('.f27-inert.is-embed .f27-embed-toggle').first().click();
  await sleep(1500);
  const openEmbed = await ctxOf(iRead);
  out.embed_open = openEmbed;
  const exp = openEmbed.expansions[0];
  const nested = exp && exp.refs[0];
  const inner = exp && exp.assets[0];
  check(
    'expanding-shows-the-targets-own-text-read-only-and-bounded',
    !!exp && /Practice beats intention/.test(exp.text) && exp.size <= 420 && exp.collapse &&
      openEmbed.og.embeds === 0 && openEmbed.og.editors === 0,
    `${exp ? exp.size : 0} displayed character(s): ${JSON.stringify(exp && exp.text.slice(0, 60))}; ` +
      `collapse control = ${exp && exp.collapse}; OG embed renderings = ${openEmbed.og.embeds}`
  );
  check(
    'inside-an-expansion-a-reference-is-closed-and-a-picture-is-only-named',
    !!nested && nested.mark === '⋯' && !!inner && inner.thumb === null && exp.imgs === 0,
    `nested reference marker = ${JSON.stringify(nested && nested.mark)}; ` +
      `asset inside = ${JSON.stringify(inner && inner.name)} with thumbnail = ${!!(inner && inner.thumb)}; ` +
      `images inside the expansion = ${exp && exp.imgs}`
  );
  await away();
  await row(iRead).locator('.f27-embed-collapse').first().click();
  await sleep(1200);
  const recollapsed = await ctxOf(iRead);
  check(
    'collapsing-returns-the-chip-to-the-state-it-started-in',
    recollapsed.expansions.length === 0 && recollapsed.embeds[0] && recollapsed.embeds[0].expanded === 'false',
    `expansions on screen = ${recollapsed.expansions.length}; aria-expanded = ${recollapsed.embeds[0] && recollapsed.embeds[0].expanded}`
  );
  await openCtx(iRead);

  // =========================================================================
  // PART 9 — a page embed, read as a bounded excerpt
  // =========================================================================
  phase('excerpt');
  const iStudy = await rowIdx('Study Plan');
  await openCtx(iStudy);
  await sleep(1200);
  const closedPage = await ctxOf(iStudy);
  out.excerpt_closed = closedPage;
  const pchip = closedPage.pageEmbeds[0];
  check(
    'a-page-embed-starts-as-the-name-and-page-control-it-already-was',
    !!pchip && pchip.badge === '{{embed}}' && pchip.text === demo.PAGE_EXCERPT && pchip.pageOpen &&
      pchip.toggle && pchip.expanded === 'false' && closedPage.excerpts.length === 0,
    `chip = ${JSON.stringify([pchip && pchip.badge, pchip && pchip.text])}; page control = ${pchip && pchip.pageOpen}; ` +
      `excerpts on screen = ${closedPage.excerpts.length}`
  );
  await away();
  await row(iStudy).locator('.f27-inert.is-embed.is-page .f27-embed-toggle').first().click();
  await sleep(1600);
  const openPage = await ctxOf(iStudy);
  out.excerpt_first = openPage;
  const ex = openPage.excerpts[0];
  check(
    'expanding-shows-five-top-level-blocks-in-the-pages-own-order',
    !!ex && ex.rows.length === 5 &&
      /첫 번째 최상위 블록/.test(ex.rows[0].text) &&
      ex.rows[1].badges.some((b) => /H2/.test(b)) &&
      ex.rows[2].badges.some((b) => /TODO/.test(b)),
    `${ex ? ex.rows.length : 0} block(s); first = ${JSON.stringify(ex && ex.rows[0].text.slice(0, 40))}; ` +
      `badges = ${JSON.stringify(ex && ex.rows.map((r) => r.badges))}`
  );
  check(
    'the-excerpt-says-it-is-an-excerpt-and-names-what-it-leaves-out',
    !!ex && /[Ee]xcerpt/.test(ex.title) && ex.title.includes(demo.PAGE_EXCERPT) &&
      /20/.test(ex.limits) && /420/.test(ex.limits) && /[Cc]hildren/.test(ex.limits) && ex.more,
    `title = ${JSON.stringify(ex && ex.title)}; limits = ${JSON.stringify(ex && ex.limits)}; ` +
      `Show-more control = ${ex && ex.more}`
  );
  const stated = ex ? ex.rows.filter((r) => /children not shown/i.test(r.children)).length : 0;
  const childLeak = /A CHILD of the first block|GRANDCHILD|발췌에는 나타나지 않는/.test(openPage.text);
  check(
    'children-are-stated-and-never-traversed',
    stated >= 1 && !childLeak,
    `${stated} row(s) say children exist; a child's own words on screen = ${childLeak}`
  );
  check(
    'the-excerpt-runs-none-of-ogs-own-page-rendering',
    !!ex && openPage.og.embeds === 0 && openPage.og.iframes === 0 && openPage.og.editors === 0,
    `OG embed/query renderings = ${openPage.og.embeds}; iframes = ${openPage.og.iframes}`
  );
  await away();
  await row(iStudy).locator('.f27-page-embed-more').first().click();
  await sleep(1600);
  const morePage = await ctxOf(iStudy);
  out.excerpt_second = morePage;
  const ex2 = morePage.excerpts[0];
  check(
    'show-more-adds-the-remaining-top-level-blocks-and-then-stops-offering',
    !!ex2 && ex2.rows.length === 8 && ex2.more === false &&
      /The eighth and last top-level block/.test(ex2.rows[7].text),
    `${ex2 ? ex2.rows.length : 0} block(s) after Show more; further control = ${ex2 && ex2.more}; ` +
      `last = ${JSON.stringify(ex2 && ex2.rows[7] && ex2.rows[7].text.slice(0, 50))}`
  );
  const oversized = ex2 && ex2.rows.find((r) => r.cut);
  check(
    'an-oversized-block-in-an-excerpt-is-shortened-rather-than-quoted-whole',
    !!oversized && oversized.size <= 420 && /[Ss]hortened/.test(oversized.note),
    oversized
      ? `the oversized block renders ${oversized.size} of a 420 bound, and says "${oversized.note}"`
      : `no block was shortened; sizes = ${JSON.stringify(ex2 && ex2.rows.map((r) => r.size))}`
  );
  const statedAll = ex2 ? ex2.rows.filter((r) => /children not shown/i.test(r.children)).length : 0;
  check(
    'both-blocks-that-have-children-say-so-and-neither-is-traversed',
    statedAll >= 2 && !/A CHILD of the first block|GRANDCHILD|발췌에는 나타나지 않는/.test(morePage.text),
    `${statedAll} of ${ex2 ? ex2.rows.length : 0} blocks state that children exist; ` +
      `a child's own words on screen = ${/A CHILD of the first block|GRANDCHILD|발췌에는 나타나지 않는/.test(morePage.text)}`
  );

  const exAsset = ex2 && ex2.rows.map((r) => r.assets).flat()[0];
  const exRef = ex2 && ex2.rows.map((r) => r.refs).flat()[0];
  check(
    'inside-an-excerpt-a-picture-is-only-named-and-a-reference-stays-closed',
    !!exAsset && exAsset.thumb === null && !!exRef && exRef.mark === '⋯' &&
      ex2.rows.every((r) => r.imgs === 0),
    `asset = ${JSON.stringify(exAsset && exAsset.name)} with thumbnail = ${!!(exAsset && exAsset.thumb)}; ` +
      `reference marker = ${JSON.stringify(exRef && exRef.mark)}`
  );
  await away();
  await row(iStudy).locator('.f27-embed-collapse').first().click();
  await sleep(1200);
  const closedAgain = await ctxOf(iStudy);
  check(
    'the-excerpt-collapses-again',
    closedAgain.excerpts.length === 0,
    `excerpts on screen after collapse = ${closedAgain.excerpts.length}`
  );
  await openCtx(iStudy);

  // =========================================================================
  // PART 10 — what a panel refuses
  // =========================================================================
  phase('refusals');
  const iLink = await rowIdx('Link Check');
  await openCtx(iLink);
  await sleep(1400);
  const link = await ctxOf(iLink);
  out.link_check = link;
  const outside = link.assets.filter((a) => /is-outside/.test(a.cls));
  check(
    'a-path-that-climbs-out-of-the-graph-is-named-refused-and-given-no-control',
    outside.length === 2 && outside.every((a) => /outside this graph/.test(a.missing) && a.open === false) &&
      !link.imgSrcs.some((s) => /outside-sentinel/.test(s)),
    `${outside.length} refused path(s): ${JSON.stringify(outside.map((a) => [a.name, a.missing, a.open]))}; ` +
      `images on screen = ${JSON.stringify(link.imgSrcs)} — a real picture sits where those paths resolve`
  );
  const remote = link.assets.find((a) => /is-remote/.test(a.cls));
  check(
    'a-picture-on-the-web-is-named-not-loaded',
    !!remote && remote.badge === 'WEB' && !remote.thumb,
    remote ? `${remote.badge} ${remote.name}; thumbnail = ${!!remote.thumb}` : 'no remote chip found'
  );
  const macros = link.inert.filter((x) => /is-macro/.test(x.cls) || /\{\{/.test(x.badge || ''));
  check(
    'a-query-a-remote-player-and-raw-markup-are-named-and-run-nothing',
    macros.length >= 2 && link.og.embeds === 0 && link.og.iframes === 0 &&
      link.og.video === 0 && link.og.audio === 0 &&
      link.inert.every((x) => x.elementsFromMarkup === 0),
    `${macros.length} inert construct(s) ${JSON.stringify(link.inert.map((x) => x.badge || x.text.slice(0, 24)))}; ` +
      `queries/players/embeds rendered = ${link.og.embeds + link.og.iframes + link.og.video + link.og.audio}; ` +
      `elements produced by markup = ${link.inert.reduce((n, x) => n + x.elementsFromMarkup, 0)}`
  );
  await openCtx(iLink);

  // The preview budget, measured across every context this run opened.
  const bounds = (out.bounds = { perPreview: [], perBody: [], cut: 0 });
  for (const key of ['weekly_review', 'field_notes', 'attachments', 'embed_open', 'excerpt_second', 'link_check']) {
    const c = out[key];
    if (!c) continue;
    for (const pv of c.previews) {
      bounds.perPreview.push(pv.size);
      if (pv.cut) bounds.cut++;
    }
    bounds.perBody.push(c.previews.reduce((a, b) => a + b.size, 0));
  }
  const sizes = bounds.perPreview;
  // The bound is a maximum, not a target: the cut lands on a grapheme boundary,
  // so a Korean syllable is never split and the result can be a character or
  // two short of it. What must be true is that nothing exceeded the bound and
  // that something was actually shortened.
  check(
    'a-long-quoted-block-is-shortened-to-the-preview-bound-rather-than-emitted-whole',
    sizes.every((n) => n <= 160) && bounds.perBody.every((n) => n <= 420) && bounds.cut >= 1,
    `largest single preview = ${Math.max(0, ...sizes)} of 160, from a ${demo.LONG_TEXT.length}-character block; ` +
      `${bounds.cut} preview(s) marked as shortened; largest body total = ${Math.max(0, ...bounds.perBody)} of 420`
  );

  // =========================================================================
  // PART 11 — the keyboard
  // =========================================================================
  phase('keyboard');
  await openCtx(iRead);
  await sleep(1200);
  await page.locator('.f27-ref-row').nth(iRead).locator('.f27-inert.is-embed .f27-embed-toggle').first().focus();
  const focused = await page.evaluate(() => {
    const a = document.activeElement;
    return { cls: (a && a.className && a.className.toString()) || '', tag: a && a.tagName };
  });
  await page.keyboard.press('Enter');
  await sleep(1500);
  const byKey = await ctxOf(iRead);
  out.keyboard = { focused, expansions: byKey.expansions.length };
  check(
    'the-embed-control-is-a-button-that-works-from-the-keyboard',
    focused.tag === 'BUTTON' && /f27-embed-toggle/.test(focused.cls) && byKey.expansions.length === 1,
    `focus landed on <${focused.tag} class="${focused.cls}">; expansions after Enter = ${byKey.expansions.length}`
  );
  await page.keyboard.press('Enter'); // leave it as it was found
  await sleep(900);
  await openCtx(iRead);

  // =========================================================================
  // Closing facts about the whole run
  // =========================================================================
  const editing = await page.evaluate(() => document.querySelectorAll('textarea.editor-input').length);
  check('the-walkthrough-never-opened-an-editor', editing === 0, `editor textareas open = ${editing}`);

  const reqs = ctx.requests();
  const panelReqs = reqs.filter((r) => PANEL_PHASES.has(r.phase) && !LOCAL.test(r.url));
  const otherReqs = reqs.filter((r) => !PANEL_PHASES.has(r.phase) && !LOCAL.test(r.url));
  out.requests = {
    panel: panelReqs.map((r) => r.phase + ': ' + r.url.slice(0, 90)),
    outsidePanels: otherReqs.map((r) => r.phase + ': ' + r.url.slice(0, 90)),
  };
  check(
    'no-panel-fetched-anything-across-the-whole-walkthrough',
    panelReqs.length === 0,
    `${panelReqs.length} remote request(s) while a panel was on screen. Outside those phases OG made ` +
      `${otherReqs.length} of its own — opening the graph and rendering ordinary pages, which is its own ` +
      `behaviour and is reported rather than claimed clean ${JSON.stringify(out.requests.outsidePanels)}`
  );

  await page
    .screenshot({ path: path.join(ctx.previewDir, 'preview-integrated-walkthrough.png') })
    .catch(() => {});
}

module.exports = { walkthroughIntegrated, PANEL_PHASES, LOCAL };
