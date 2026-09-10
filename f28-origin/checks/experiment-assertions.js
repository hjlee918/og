'use strict';
//
// WHAT THE ORIGIN EXPERIMENT HAS TO PROVE, IN THE RUNNING APPLICATION.
//
// The diagnosis was measured on fixture pages. These are the same questions
// asked of the real build, plus the ones a fixture cannot answer:
//
//   * the renderer really is on `lsp://logseq.com` — not "the define compiled
//     in", which the build already asserted, but the URL the window ended up at;
//   * plugin entries really are `lsp://logseq.io/<id>/...`;
//   * the two origins stay SEPARATE — same scheme, different host, so the
//     application and its plugins remain mutually cross-origin;
//   * plugins actually LOAD: handshake completed, `loaded true`, no timeout;
//   * the hardened handler refuses what it must, asked adversarially over the
//     scheme the application now runs on — an unknown host, `../`, PERCENT
//     ENCODED `../`, and an encoded absolute path;
//   * `assets://` still resolves local graph assets from the new origin, and
//     nothing reached for the remote asset domain.
//
// Every probe is a READ. The adversarial URLs are fetched, never written, and
// they name paths outside the application that must not resolve.
//
const fs = require('fs');
const path = require('path');

// A 1x1 PNG, written into the run's OWN synthetic graph so `assets://` has
// something real and test-owned to resolve.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64');

function placeAssetProbe(graphDir) {
  const dir = path.join(graphDir, 'assets');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'f28-origin-probe.png');
  fs.writeFileSync(p, PNG_1X1);
  return p;
}

/** The renderer's own URL and origin, and the plugin iframes' origins. */
async function readOrigins(page) {
  return page.evaluate(() => {
    const frames = [...document.querySelectorAll('iframe.lsp-iframe-sandbox')]
      .map((f) => f.getAttribute('src') || '');
    let sandboxContainerSrcs = [];
    try {
      sandboxContainerSrcs = [...document.querySelectorAll('.lsp-iframe-sandbox-container iframe')]
        .map((f) => f.getAttribute('src') || '');
    } catch (e) { /* reported by the counts elsewhere */ }
    return {
      href: location.href,
      origin: location.origin,
      protocol: location.protocol,
      jsRoot: (window.frontend && window.frontend.util && window.frontend.util.JS_ROOT) || null,
      sandboxIframeSrcs: frames,
      sandboxContainerSrcs,
    };
  }).catch((e) => ({ error: String(e && e.message) }));
}

/**
 * Ask the hardened `lsp://` handler for things it must refuse, and one thing it
 * must serve. `fetch` is used because the scheme is registered
 * `supportFetchAPI`, so a refusal surfaces as a rejected promise or a non-ok
 * response rather than as a silent blank frame.
 */
async function probeHandler(page) {
  return page.evaluate(async () => {
    const cases = [
      { name: 'app resource, legitimate', url: 'lsp://logseq.com/js/lsplugin.core.js', expect: 'serve' },
      { name: 'unknown host', url: 'lsp://evil.example/js/lsplugin.core.js', expect: 'refuse' },
      { name: 'traversal', url: 'lsp://logseq.com/../../../../../../etc/passwd', expect: 'refuse' },
      { name: 'percent-encoded traversal',
        url: 'lsp://logseq.com/%2e%2e%2f%2e%2e%2f%2e%2e%2f%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd',
        expect: 'refuse' },
      { name: 'encoded absolute path', url: 'lsp://logseq.com/%2Fetc%2Fpasswd', expect: 'refuse' },
      { name: 'plugin host traversal', url: 'lsp://logseq.io/../../../../../../etc/passwd', expect: 'refuse' },
      { name: 'mixed encoded traversal on plugin host',
        url: 'lsp://logseq.io/x/%2e%2e/%2e%2e/%2e%2e/%2e%2e/etc/passwd', expect: 'refuse' },
    ];
    const out = [];
    for (const c of cases) {
      const row = { name: c.name, url: c.url, expect: c.expect, ok: null, status: null,
                    bytes: null, threw: null, body: null };
      try {
        const r = await fetch(c.url);
        row.ok = r.ok;
        row.status = r.status;
        const t = await r.text();
        row.bytes = t.length;
        // Only ever recorded for a response that should NOT have existed.
        if (c.expect === 'refuse' && r.ok) row.body = t.slice(0, 120);
      } catch (e) {
        row.threw = String((e && e.message) || e).slice(0, 160);
      }
      out.push(row);
    }
    return out;
  }).catch((e) => [{ name: 'probe failed', threw: String(e && e.message) }]);
}

/** Does a local graph asset still load from the new origin? */
async function probeAsset(page, assetPath) {
  return page.evaluate((p) => new Promise((resolve) => {
    const url = 'assets://' + encodeURI(p);
    const img = new Image();
    const done = (r) => resolve(Object.assign({ url }, r));
    img.onload = () => done({ loaded: true, w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => done({ loaded: false });
    img.src = url;
    setTimeout(() => done({ loaded: false, timedOut: true }), 8000);
  }), assetPath).catch((e) => ({ loaded: false, error: String(e && e.message) }));
}

/**
 * Summarise a plugin-host reading against what the experiment claims: entries
 * on the plugin origin, and plugins that actually finished loading.
 */
function summariseLoad(ps, wantIds) {
  const rows = (ps.plugins || []).map((p) => ({
    key: p.key,
    status: p.status,
    loaded: p.loaded === true,
    loadError: p.loadError || null,
    entry: (p.options && p.options.entry) || null,
  }));
  return {
    rows,
    allRegistered: wantIds.every((id) => (ps.registered || []).includes(id)),
    loadedCount: rows.filter((r) => r.loaded).length,
    entriesOnPluginOrigin: rows.length > 0 &&
      rows.every((r) => typeof r.entry === 'string' && r.entry.startsWith('lsp://logseq.io/')),
    anyHandshakeTimeout: rows.some((r) => /handshake Timeout/i.test(r.loadError || '')),
    anyFileEntry: rows.some((r) => typeof r.entry === 'string' && r.entry.startsWith('file://')),
  };
}

module.exports = { PNG_1X1, placeAssetProbe, readOrigins, probeHandler, probeAsset, summariseLoad };
