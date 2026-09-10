'use strict';
//
// ONE reading of a page's linked-references section, shared by the ordering
// slice's two scenarios.
//
// It lives in its own module for the same reason `packaged-app.js` does: the
// baseline run and the feature run make claims ABOUT THE SAME MEASUREMENT —
// "OG draws the groups in this order" and "the control changes that order to
// this one" — and two copies of a reader would let those two claims quietly
// come to mean different things.
//
// TWO RULES THIS READER FOLLOWS.
//
//   * A GROUP IS IDENTIFIED BY `data-ref`, NEVER BY ITS TITLE TEXT. `data-ref`
//     is `page-name-sanity-lc`, OG's own identity mandate for `:block/name`.
//     The title is the thing being sorted; identifying a group by it would
//     make every ordering assertion circular.
//   * A READING IS ONLY A READING ONCE IT HAS SETTLED. `references*` renders
//     each source page's item inside `ui/lazy-visible`, an IntersectionObserver
//     placeholder that fills in on scroll, and a re-render remounts items as
//     placeholders again. The child-context and reference-role batches both
//     recorded a run that measured a partially-drawn list and drew a wrong
//     conclusion from it. `makeSettle` scrolls until the row count is stable
//     across consecutive readings, and every read in both scenarios goes
//     through it.
//
const OP = require('../../f27-pilot/checks/owned-process.js');

const sleep = OP.sleep;

/**
 * A settle function bound to one page.
 *
 * Scrolls the main container through its range until the number of rows drawn
 * in the linked-references section is stable across three consecutive
 * readings, then parks the pointer so no hover state is left behind.
 */
function makeSettle(page, session, say = () => {}) {
  const parkPointer = session && session.parkPointer
    ? session.parkPointer
    : () => page.mouse.move(5, 5).catch(() => null);
  return async function settle(why) {
    let seen = -1;
    let stable = 0;
    for (let i = 0; i < 24 && stable < 3; i++) {
      await page.evaluate((step) => {
        const m = document.querySelector('#main-content-container') || document.body;
        const max = m.scrollHeight - m.clientHeight;
        m.scrollTop = max > 0 ? Math.min(max, (step % 6) * (max / 5)) : 0;
        window.scrollTo(0, (step % 6) * (document.body.scrollHeight / 5));
      }, i).catch(() => null);
      await sleep(1200);
      const n = await page.evaluate(() =>
        document.querySelectorAll('.references.page-linked .ls-block[blockid]').length)
        .catch(() => 0);
      if (n === seen) stable += 1; else { seen = n; stable = 0; }
    }
    await parkPointer();
    say(`          (settled at ${seen} rows${why ? ` ${why}` : ''})`);
    return seen;
  };
}

/**
 * Everything both scenarios need about the section, in one evaluate.
 *
 * `groups` is in DOM order — the order the reader sees — and each carries the
 * rows drawn inside it, in their own DOM order, so "the groups moved" and "the
 * rows inside a group did not" are two separately checkable facts.
 */
function read(page) {
  return page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const sec = document.querySelector('.references.page-linked');
    if (!sec) return { present: false };

    const allRows = [...sec.querySelectorAll('.ls-block[blockid]')];
    const index = new Map(allRows.map((el, i) => [el, i]));
    const parentOf = (el) => {
      let p = el.parentElement;
      while (p && p !== sec) {
        if (p.classList && p.classList.contains('ls-block') && p.hasAttribute('blockid')) {
          return index.has(p) ? index.get(p) : null;
        }
        p = p.parentElement;
      }
      return null;
    };
    const readRow = (el) => {
      const main = el.querySelector(':scope > .block-main-container');
      const label = main ? main.querySelector(':scope > .f28-role') : null;
      return {
        i: index.get(el),
        id: el.getAttribute('blockid'),
        parent: parentOf(el),
        level: el.getAttribute('level'),
        // The DOM id carries `blocks-container-id`, which is minted once per
        // mounted container. It is how "this group survived being moved"
        // is told apart from "this group was rebuilt in its new place".
        domId: el.getAttribute('id'),
        text: clean(main ? main.innerText : '').slice(0, 80),
        refsSelf: el.getAttribute('data-refs-self'),
        role: label ? label.getAttribute('data-f28-role') : null,
        roleText: label ? clean(label.innerText) : null,
        ctxControl: !!el.querySelector(':scope > .f28-ctx > .f28-ctx-open'),
        ctxControlId: (() => {
          const b = el.querySelector(':scope > .f28-ctx > .f28-ctx-open');
          return b ? b.getAttribute('id') : null;
        })(),
        ctxControls: el.querySelector(':scope > .f28-ctx > .f28-ctx-open')
          ? el.querySelector(':scope > .f28-ctx > .f28-ctx-open').getAttribute('aria-controls')
          : null,
      };
    };

    const wrap = sec.querySelector('.references-blocks-wrap');
    const groups = [...sec.querySelectorAll('.references-blocks-item')].map((item, gi) => {
      const header = item.querySelector('.foldable-title');
      const link = header ? header.querySelector('a.page-ref, a.tag') : null;
      const rows = [...item.querySelectorAll('.ls-block[blockid]')].map(readRow);
      const crumbs = [...item.querySelectorAll('.blocks-container')].map((bc) => {
        const holder = bc.parentElement;
        const crumb = holder ? holder.querySelector(':scope > .breadcrumb') : null;
        const steps = crumb
          ? [...crumb.children].filter((c) => !c.classList.contains('ui__icon'))
              .map((c) => clean(c.innerText))
          : [];
        return {
          crumb: crumb ? clean(crumb.innerText) : null,
          steps,
          more: steps.filter((s) => s === '⋯').length,
          ids: [...bc.querySelectorAll('.ls-block[blockid]')].map((e) => e.getAttribute('blockid')),
        };
      });
      return {
        gi,
        ref: link ? link.getAttribute('data-ref') : null,
        title: clean(header ? header.innerText : '').replace(/\s*Alias$/, ''),
        alias: !!(header && /\bAlias\b/.test(header.innerText || '')),
        placeholder: !link,
        rowIds: rows.map((r) => r.id),
        rowTree: rows.map((r) => ({ id: r.id, parent: r.parent, level: r.level,
                                    role: r.role, text: r.text })),
        domIds: rows.map((r) => r.domId),
        crumbs,
      };
    });

    // Every control a keyboard can stop on, described structurally rather than
    // by the words it happens to carry — the fixture's own page names would
    // otherwise decide whether an ordering control was "found".
    const focusable = [...sec.querySelectorAll(
      'a[href], a[tabindex], button, input, select, textarea, [tabindex]:not([tabindex="-1"])')]
      .map((el) => ({
        kind: el.tagName.toLowerCase() +
          (el.classList.contains('page-ref') ? '.page-ref'
            : el.classList.contains('tag') ? '.tag'
            : el.classList.contains('filter') ? '.filter'
            : el.className && typeof el.className === 'string' && el.className.trim()
              ? '.' + el.className.trim().split(/\s+/)[0] : ''),
        label: el.getAttribute('aria-label'),
        title: el.getAttribute('title'),
        text: clean(el.innerText).slice(0, 40),
        cls: typeof el.className === 'string' ? el.className : '',
        orderAttr: el.getAttribute('data-f28-order'),
      }));

    // A control, for the purpose of "does OG offer an ordering control": a
    // form element or a pressable thing. A page link is not one, which is why
    // it is excluded here — the fixture is full of page links.
    const controlEls = [...sec.querySelectorAll(
      'select, input, button, [role="button"], [role="menuitem"], [role="listbox"], a.fade-link')];
    const sortWord = /order|sort|정렬|순서/i;

    const orderSelect = sec.querySelector('select.f28-order-select');

    return {
      present: true,
      heading: clean((sec.querySelector('h2') || {}).innerText),
      wrapOrder: wrap ? wrap.getAttribute('data-f28-order') : null,
      controlOrder: orderSelect ? orderSelect.getAttribute('data-f28-order') : null,
      controlValue: orderSelect ? orderSelect.value : null,
      controlLabel: orderSelect ? orderSelect.getAttribute('aria-label') : null,
      controlTitle: orderSelect ? orderSelect.getAttribute('title') : null,
      controlOptions: orderSelect
        ? [...orderSelect.options].map((o) => ({ value: o.value, text: clean(o.textContent) }))
        : [],
      controlTabIndex: orderSelect ? orderSelect.getAttribute('tabindex') : null,
      controlFocused: !!(orderSelect && document.activeElement === orderSelect),
      controlInHeading: !!(orderSelect && orderSelect.closest('.foldable-title')),
      groups,
      rows: allRows.map(readRow),
      selects: sec.querySelectorAll('select').length,
      orderControls: sec.querySelectorAll('[data-f28-order]').length,
      sortWordControls: controlEls.filter((el) => sortWord.test(
        `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ` +
        `${el.textContent || ''}`)).length,
      focusable,
      labels: sec.querySelectorAll('.f28-role').length,
      ctxControls: sec.querySelectorAll('.f28-ctx-open').length,
      pathControls: sec.querySelectorAll('.f28-path-toggle').length,
      filterControl: !!sec.querySelector('a.filter'),
      unlinked: !!document.querySelector('.references.page-unlinked'),
      editors: sec.querySelectorAll('textarea').length,
      openPanels: sec.querySelectorAll('.f28-ctx-panel').length,
    };
  }).catch((e) => ({ present: false, error: String(e && e.message) }));
}

/** The reading, small enough to keep in an evidence file. */
function lean(r) {
  return JSON.parse(JSON.stringify({
    present: r.present,
    heading: r.heading,
    wrapOrder: r.wrapOrder,
    controlOrder: r.controlOrder,
    controlOptions: r.controlOptions,
    groups: (r.groups || []).map((g) => ({
      gi: g.gi, ref: g.ref, title: g.title, alias: g.alias,
      rowIds: g.rowIds, rowTree: g.rowTree, domIds: g.domIds,
      crumbs: g.crumbs,
    })),
    rowCount: (r.rows || []).length,
    labels: r.labels,
    ctxControls: r.ctxControls,
    pathControls: r.pathControls,
    filterControl: r.filterControl,
    unlinked: r.unlinked,
    editors: r.editors,
    selects: r.selects,
    focusableKinds: [...new Set((r.focusable || []).map((f) => f.kind))],
  }));
}

/** The groups in DOM order, by the identity they are compared on. */
function orderOf(r) {
  return (r.groups || []).map((g) => g.ref);
}

/**
 * The rows of one group, keyed by the group's identity — what "nothing inside
 * a group moved" is compared across two readings.
 */
function insideOf(r) {
  const out = {};
  for (const g of r.groups || []) {
    out[g.ref] = {
      rowIds: g.rowIds,
      tree: g.rowTree.map((x) => `${x.id}<${x.parent}@${x.level}`),
      crumbs: g.crumbs.map((c) => `${c.steps.join('›')}::${c.ids.join(',')}`),
    };
  }
  return out;
}

module.exports = { makeSettle, read, lean, orderOf, insideOf, sleep };
