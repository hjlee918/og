'use strict';
//
// THE SHORT REFERENCE JOURNEY, AND THE PLUGIN-HOST READERS, IN ONE PLACE.
//
// The combined scenario's readers and gestures are closures inside its own
// `main()`, so a second scenario cannot call them. This module is those same
// measurements, in the same vocabulary, exported — the selectors, the settle
// rule, the badge round-trip, the two F28 disclosures, the language seam and
// the keyboard entry point. Nothing here asserts; every function returns a
// reading or performs one named gesture, and the scenario decides what it
// means.
//
// Keeping ONE copy matters for the question this batch asks. "Does the
// reference bundle still behave with a plugin present" is only answerable if
// the plugin-free and plugin-present readings are the SAME measurement, and
// two hand-copied readers would not be.
//
// THE PLUGIN READERS ARE DELIBERATELY NON-INVOKING. They read `LSPluginCore`'s
// own report of what it registered and what state each plugin reached, plus
// the DOM surfaces a plugin would have injected. Nothing calls a plugin's
// model, presses a plugin's button, opens a plugin's settings, or triggers a
// command. Enrolment, initialisation and surface creation are read; plugin
// FUNCTIONALITY is never exercised.
//
const OP = require('../../f27-pilot/checks/owned-process.js');

const sleep = OP.sleep;

/**
 * Bind the journey to one open session.
 *
 * @param {object} o
 *   page     the Playwright page
 *   session  the object `packaged-app.open` returned
 *   CG       the combined-graph fixture module (names and uuids)
 *   say      the scenario's logger
 */
function create({ page, session, CG, say = () => {} }) {
  const U = CG.UUID;
  const T = CG.TEXT;
  const goTo = session.goTo;
  const parkPointer = session.parkPointer;

  /** Lazy rendering settles when the row count stops moving. */
  async function settle(why) {
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
  }

  // -------------------------------------------------------------------------
  // The reference surfaces
  // -------------------------------------------------------------------------

  /** The anchor page's main content: the inline surface and the badge row. */
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
                   embedShowsTarget: (blockText(uuids.badgeHost) || '').includes(uuids.targetNeedle),
                   badgeLink: inBlock(uuids.badgeHost, 'a.open-block-ref-link') },
      hostMain: { present: block(uuids.hostMain),
                  wrapped: inBlock(uuids.hostMain, '.f27-il'),
                  toggle: inBlock(uuids.hostMain, '.f27-il-toggle') },
      overview: !!main.querySelector('.f27-ref-overview'),
      editors: document.querySelectorAll('textarea[aria-label="editing block"]').length,
      hash: location.hash,
    };
  }, { badgeHost: U.badgeHost, hostMain: U.hostMain,
       targetNeedle: T.badgeTarget.split(' ·')[0] })
    .catch((e) => ({ error: String(e.message) }));

  /** The F27 compact overview: its rows, their contexts, and the Crystal marker. */
  const ovState = () => page.evaluate(() => {
    const p = document.querySelector('.f27-ref-overview');
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const txt = (root, sel) => {
      const e = root.querySelector(sel);
      return e ? clean(e.innerText) : null;
    };
    if (!p) return { present: false, rows: [], crystal: null, leak: {} };
    const body = clean(p.innerText);
    return {
      present: true,
      title: txt(p, '.f27-ref-overview-title'),
      crystal: {
        toggle: txt(p, '.f27-crystal-config-toggle'),
        options: [...p.querySelectorAll('.f27-crystal-option')].map((o) => clean(o.innerText)),
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
            .map((l) => clean(l.innerText)) : null,
          children: ctx ? [...ctx.querySelectorAll('.f27-desc-line')]
            .map((l) => clean(l.innerText)) : null,
          inOpen: !!inBody,
          inDirection: inBody ? txt(inBody, '.f27-in-direction') : null,
          inItems: inBody ? [...inBody.querySelectorAll('.f27-in-item')]
            .map((e) => clean(e.innerText).slice(0, 80)) : null,
        };
      }),
      // A compact reading view must not leak raw identifiers.
      leak: {
        uuid: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(body),
        id: /\bid::/.test(body),
      },
    };
  }).catch((e) => ({ present: false, rows: [], crystal: null, leak: {}, error: String(e.message) }));

  /**
   * Go to the badge target's own page and scroll until OG has drawn it.
   * The target sits below a five-ancestor chain, so lazy rendering has to be
   * driven rather than waited on.
   */
  const badgeSite = async () => {
    await goTo(CG.BADGE_PAGE);
    let site = null;
    for (let i = 0; i < 14 && !(site && site.present && site.badge); i++) {
      site = await page.evaluate((uuid) => {
        const main = document.querySelector('#main-content-container') || document.body;
        const el = main.querySelector(`[blockid="${uuid}"]`);
        const a = el ? el.querySelector('a.open-block-ref-link') : null;
        if (el) el.scrollIntoView({ block: 'center' });
        else main.scrollTop = main.scrollHeight;
        return { present: !!el, badge: !!a,
                 count: a ? (a.innerText || '').replace(/\s+/g, ' ').trim() : null };
      }, U.badgeTarget).catch(() => null);
      if (!(site && site.present && site.badge)) await sleep(900);
    }
    await sleep(1200);
    await parkPointer();
    return site;
  };

  /** The badge is a toggle (`swap! *show-ref-overview? not`). */
  const toggleBadge = async (ms = 2600) => {
    await parkPointer();
    await page.locator(`#main-content-container [blockid="${U.badgeTarget}"] a.open-block-ref-link`)
      .first().click({ timeout: 20000 }).catch(() => {});
    await sleep(ms);
  };

  /** Open one overview row's ancestors/children, if it is not open already. */
  const ensureRowCtx = async (i) => {
    let s = await ovState();
    if (!s.present) return null;
    if (!(s.rows[i] && s.rows[i].ctxOpen)) {
      await parkPointer();
      await page.locator('.f27-ref-row').nth(i).locator('.f27-ctx-toggle').first()
        .click({ timeout: 15000 }).catch(() => {});
      await sleep(1600);
      s = await ovState();
    }
    return s.rows[i] || null;
  };

  /** Open one overview row's inbound explorer, if it is not open already. */
  const ensureRowIn = async (i) => {
    let r = await ensureRowCtx(i);
    if (!r) return null;
    if (!r.inOpen) {
      await parkPointer();
      await page.locator('.f27-ref-row').nth(i).locator('.f27-in-toggle').first()
        .click({ timeout: 15000 }).catch(() => {});
      await sleep(1900);
      r = (await ovState()).rows[i] || null;
    }
    return r;
  };

  /** Both F28 disclosures of the linked-references list, per row and per group. */
  const disclosureState = () => page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const sec = document.querySelector('.references.page-linked');
    if (!sec) return { present: false };
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
    for (const el of sec.querySelectorAll('.ls-block[blockid]')) {
      byId[el.getAttribute('blockid')] = readCtx(el);
    }
    const UUID_RE = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
    const paths = [...sec.querySelectorAll('.f28-path')]
      .filter((h) => h.querySelector(':scope > .breadcrumb .f28-path-toggle'))
      .map((h) => {
        const toggle = h.querySelector(':scope > .breadcrumb .f28-path-toggle');
        const panel = h.querySelector(':scope > .f28-path-panel');
        const tid = (toggle && toggle.id) || '';
        const m = tid.match(new RegExp(UUID_RE + '-toggle$'));
        return {
          crumbId: m ? m[1] : null,
          crumb: clean((h.querySelector(':scope > .breadcrumb') || {}).innerText),
          toggleId: toggle ? toggle.id : null,
          expanded: toggle ? toggle.getAttribute('aria-expanded') : null,
          ariaLabel: toggle ? toggle.getAttribute('aria-label') : null,
          open: !!panel,
          panelId: panel ? panel.id : null,
          steps: panel ? [...panel.querySelectorAll('.f28-path-step')]
            .map((s) => clean(s.innerText)) : null,
        };
      });
    return { present: true, byId, paths,
             ctxControls: sec.querySelectorAll('.f28-ctx-open').length,
             pathControls: sec.querySelectorAll('.f28-path-toggle').length };
  }).catch((e) => ({ present: false, error: String(e && e.message) }));

  /** The words every reference control draws through `t`. */
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
      // The path toggle's inner text is the `⋯` mark, aria-hidden by design;
      // the translated words live in aria-label.
      out.pathToggle = pathBtn ? clean(pathBtn.getAttribute('aria-label') || '') : null;
    }
    return out;
  }).catch(() => null);

  /** OG's own language seam, the one the accepted scenarios use. */
  const setLanguage = (lang) => page.evaluate((l) => {
    const st = window.frontend && window.frontend.state;
    const fn = st && st.set_preferred_language_BANG_;
    if (typeof fn !== 'function') return { ok: false, reason: 'no language seam' };
    fn(l);
    return { ok: true };
  }, lang).catch((e) => ({ ok: false, reason: String(e.message) }));

  /** Choose an order through OG's own control. */
  const chooseOrder = async (value) => {
    const out = { value, changed: false, error: null };
    try {
      await page.selectOption('select.f28-order-select', value, { timeout: 15000 });
      out.changed = true;
    } catch (e) {
      out.error = String(e && e.message).split('\n')[0].slice(0, 200);
    }
    await sleep(1500);
    return out;
  };

  /** Put keyboard focus on one row's child-context control, by its own id. */
  const focusControl = (id) => page.evaluate((cid) => {
    const el = document.getElementById(cid);
    if (!el) return { ok: false, reason: 'no such control' };
    el.focus();
    return { ok: document.activeElement === el, active: document.activeElement
      ? document.activeElement.id || document.activeElement.tagName : null };
  }, id).catch((e) => ({ ok: false, reason: String(e.message) }));

  // -------------------------------------------------------------------------
  // The plugin host, read and never invoked
  // -------------------------------------------------------------------------

  /**
   * What the plugin host itself reports, plus the surfaces a loaded plugin
   * would have put on screen.
   *
   * `status`, `loaded` and the load error are the HOST's own words about each
   * plugin. Enrolment (`registeredPlugins`/`enabledPlugins`) is not loading,
   * and the two are reported separately for exactly that reason.
   */
  const pluginState = () => page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const out = {
      hostMounted: null, lspEnabled: null,
      registered: null, enabled: null, plugins: [],
      sandboxIframes: 0, sandboxContainers: 0,
      injectedUiNodes: 0, toolbarItems: [], pluginSidebarItems: 0,
      error: null,
    };
    try {
      const core = window.LSPluginCore;
      if (!core) { out.hostMounted = false; return out; }
      // `LSPluginCore.hostMounted()` IS NOT A PREDICATE. In the packaged
      // `js/lsplugin.core.js` it reads `hostMounted(){ this._hostMountedActor
      // .resolve() }` — a COMMAND that settles the actor `_onHostMounted`
      // waits on, returning undefined. The first version of this reader called
      // it, which both reported `false` for a mounted host and mutated the
      // very state it claimed to be observing. The mounted fact is read from
      // the actor itself, which is exposed read-only through
      // `get hostMountedActor()`.
      const actor = core.hostMountedActor;
      out.hostMounted = actor && typeof actor === 'object' && 'settled' in actor
        ? !!actor.settled : null;
      const reg = core.registeredPlugins;
      out.registered = reg && typeof reg.keys === 'function'
        ? Array.from(reg.keys()).map(String) : null;
      const en = core.enabledPlugins;
      out.enabled = en && typeof en.keys === 'function'
        ? Array.from(en.keys()).map(String) : null;
      if (reg && typeof reg.forEach === 'function') {
        reg.forEach((pl, key) => {
          let opts = null;
          try { opts = pl && pl.options ? { id: pl.options.id, name: pl.options.name,
                                            version: pl.options.version,
                                            entry: pl.options.entry,
                                            disabled: !!pl.options.disabled } : null; }
          catch (e) { opts = { readError: String(e && e.message) }; }
          let loadErr = null;
          try {
            const e = pl && (pl.loadErr || pl._loadErr || pl.err);
            loadErr = e ? String(e.message || e) : null;
          } catch (e) { loadErr = String(e && e.message); }
          out.plugins.push({
            key: String(key),
            status: pl ? (pl.status || pl._status || null) : null,
            loaded: pl ? !!pl.loaded : null,
            disabled: pl ? !!pl.disabled : null,
            loadError: loadErr,
            options: opts,
          });
        });
      }
    } catch (e) { out.error = String(e && e.message); }

    out.sandboxIframes = document.querySelectorAll('iframe.lsp-iframe-sandbox').length;
    out.sandboxContainers = document.querySelectorAll('.lsp-iframe-sandbox-container').length;
    out.injectedUiNodes = document.querySelectorAll('[data-injected-ui]').length;
    out.toolbarItems = [...document.querySelectorAll(
      '.ui-items-container > *, .toolbar-plugins-manager, .toolbar-plugins-manager-trigger')]
      .map((e) => ({ injected: e.getAttribute && e.getAttribute('data-injected-ui'),
                     text: clean(e.innerText).slice(0, 40) }));
    out.pluginSidebarItems = document.querySelectorAll('.sidebar-item-list [data-injected-ui]').length;
    return out;
  }).catch((e) => ({ hostMounted: null, error: String(e && e.message),
                     plugins: [], registered: null, enabled: null,
                     sandboxIframes: 0, sandboxContainers: 0, injectedUiNodes: 0,
                     toolbarItems: [], pluginSidebarItems: 0 }));

  /** OG's own command palette, read without opening or invoking anything. */
  const commandCount = () => page.evaluate(() => {
    try {
      const h = window.frontend && window.frontend.modules && window.frontend.modules.shortcut;
      void h;
      const st = window.frontend && window.frontend.state;
      const s = st && st.state ? (st.state.deref ? st.state.deref() : null) : null;
      void s;
    } catch (e) { /* the DOM reading below is the measurement that matters */ }
    return {
      slashItems: document.querySelectorAll('.command-palette-item, .ui__modal-panel .cp__palette-item').length,
      pluginSlash: document.querySelectorAll('[data-injected-ui*="slash"]').length,
    };
  }).catch(() => ({ slashItems: null, pluginSlash: null }));

  return {
    settle, mainState, ovState, badgeSite, toggleBadge, ensureRowCtx, ensureRowIn,
    disclosureState, readLabels, setLanguage, chooseOrder, focusControl,
    pluginState, commandCount, sleep,
  };
}

module.exports = { create, sleep };
