'use strict';
//
// THE EXPERIMENT'S SOURCE-LEVEL CLAIMS.
//
// The live run is the real evidence, but a live run is expensive and these are
// the properties that decide whether it can possibly mean anything. Each one
// has a specific failure it exists to catch:
//
//   * the two halves must be COUPLED. If the renderer moved to `lsp://` and the
//     plugin entries did not, every plugin iframe would be refused outright
//     instead of timing out, and the run would look like a different bug;
//   * the experiment must be OFF by default, in both halves, or "an ordinary
//     build is unchanged" is not true;
//   * the identity must be unable to claim the ACCEPTED build's profile;
//   * the origin-sensitive renderer sites must be fixed, or the app silently
//     resolves its own assets to the REMOTE asset domain;
//   * the protocol handler must allow-list hosts and check containment.
//
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8');

const EXP = require(path.join(REPO, 'f28-origin', 'src', 'experiment-identity.js'));
const ACCEPTED = require(path.join(REPO, 'f28-refpath', 'src', 'feature-identity.js'));
const PILOT = require(path.join(REPO, 'f27-pilot', 'src', 'pilot-identity.js'));

test('the experimental identity cannot claim the accepted build\'s state', () => {
  for (const other of [ACCEPTED, PILOT]) {
    for (const k of ['SCHEMA', 'PRODUCT_NAME', 'BUNDLE_ID', 'PACKAGE_NAME',
                     'STATE_DIR', 'OWNERSHIP_MARKER', 'MANIFEST_FILE']) {
      assert.notStrictEqual(EXP[k], other[k],
        `${k} must differ from ${other.PRODUCT_NAME}, or the two builds could claim each other's profile`);
    }
  }
});

test('the experimental identity keeps the guard and boundary contract it does not own', () => {
  for (const k of ['ACTIVE_MARKER', 'INERT_MARKER', 'BOUNDARY_FILE', 'BOUNDARY_SCHEMA',
                   'GRAPH_ROOT_SEGMENTS', 'MAIN_BUNDLE', 'ISOLATED_PATHS', 'LOGS_DIR']) {
    assert.deepStrictEqual(EXP[k], ACCEPTED[k],
      `${k} belongs to the guards, not to this build's identity`);
  }
  assert.strictEqual(EXP.APP_ORIGIN, 'lsp://logseq.com');
  assert.strictEqual(EXP.PLUGIN_ORIGIN, 'lsp://logseq.io');
  assert.notStrictEqual(EXP.APP_ORIGIN, EXP.PLUGIN_ORIGIN,
    'the application and plugin origins must stay separate');
});

test('the experiment is OFF by default in both halves', () => {
  const oe = read('src', 'electron', 'electron', 'origin_experiment.cljs');
  assert.match(oe, /\(goog-define ORIGIN_EXPERIMENT false\)/,
    'the closure define must default to false');

  const ts = read('libs', 'src', 'LSPlugin.core.ts');
  assert.match(ts, /privilegedPluginResources\?: boolean/,
    'the host option must be optional, so its absence is the historical behaviour');
});

test('the two halves are coupled: plugin resources follow the RENDERER\'s protocol', () => {
  const ph = read('src', 'main', 'frontend', 'handler', 'plugin.cljs');
  assert.match(ph, /privileged\?\s+\(= "lsp:" js\/location\.protocol\)/,
    'the flag must be derived from the renderer protocol, not passed independently');
  assert.match(ph, /:privilegedPluginResources privileged\?/,
    'and it must reach setupPluginCore');
});

test('experimental theme assets stay on the guarded protocol instead of raw file URLs', () => {
  const ph = read('src', 'main', 'frontend', 'handler', 'plugin.cljs');
  assert.match(ph, /\(and \(util\/electron\?\) \(not= "lsp:" js\/location\.protocol\)\)/,
    'the lsp renderer must preserve assets: theme URLs; ordinary Electron keeps file conversion');
});

test('the renderer entry moves only under the experiment, to the same document', () => {
  const w = read('src', 'electron', 'electron', 'window.cljs');
  assert.match(w, /origin-exp\/main-window-entry/);
  const oe = read('src', 'electron', 'electron', 'origin_experiment.cljs');
  assert.match(oe, /APP_URL "lsp:\/\/logseq\.com\/"/);
  assert.match(oe, /\(if ORIGIN_EXPERIMENT\s*\n?\s*\(str APP_URL page\)/,
    'the experiment branch produces the app-scheme URL');
  assert.match(oe, /\(file-url-fn page\)/,
    'and the ordinary branch still produces the historical file:// URL');
});

test('the origin-sensitive renderer sites no longer key on the scheme name alone', () => {
  const u = read('src', 'main', 'frontend', 'util.cljc');
  assert.match(u, /defn bundled-origin\?/);
  assert.ok(!/defn file-protocol\?/.test(u), 'the misleading predicate should be gone');
  // JS_ROOT must treat lsp: like file:, or dynamic loads ask for ./static/js.
  const jsRoot = u.slice(u.indexOf('(def JS_ROOT'), u.indexOf('(def JS_ROOT') + 400);
  assert.match(jsRoot, /"file:" "lsp:"/,
    'JS_ROOT must recognise the application scheme');

  const c = read('src', 'main', 'frontend', 'config.cljs');
  assert.match(c, /\(util\/bundled-origin\?\)/,
    'asset-uri must not fall through to the remote asset domain under lsp:');
});

test('the lsp:// handler allow-lists hosts and checks canonical containment', () => {
  const core = read('src', 'electron', 'electron', 'core.cljs');
  assert.match(core, /def \^:private LSP_HOSTS \{"logseq\.com" :app "logseq\.io" :plugins\}/,
    'hosts must be an explicit allow-list');
  assert.match(core, /defn- resolve-lsp-file/);
  assert.match(core, /path-contained\?/, 'containment must be checked');
  assert.match(core, /realpathSync/, 'and symlinks resolved');
  // The old fall-through must be gone: no unknown host may reach __dirname.
  assert.ok(!/\[STATIC_URL js\/__dirname\]/.test(core),
    'the unknown-host fall-through to the application root must be removed');
  // The pilot check is kept on top, not replaced.
  assert.match(core, /pilot\/permitted-path\? path' "resource"/);
});
