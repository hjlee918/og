'use strict';
//
// THE ORIGIN EXPERIMENT BUILD, asserted where it actually is.
//
// `f28-refpath/tests/feature-build.test.js` asks these questions of the
// ACCEPTED build and skips itself when `static/` holds something else. This is
// the other half of that arrangement: whatever the accepted suite steps aside
// for, this suite asserts — so a build in `static/` is never unexamined.
//
// The experiment-specific claims are the ones a generic build check cannot
// make: BOTH closure defines applied, the plugin host bundle actually
// transformed, and the committed production bundle NOT touched.
//
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = path.resolve(__dirname, '..', '..');
const STATIC = path.join(REPO, 'static');
const ID = require(path.join(REPO, 'f28-origin', 'src', 'experiment-identity.js'));
const ACCEPTED = require(path.join(REPO, 'f28-refpath', 'src', 'feature-identity.js'));
const PILOT_ID = require(path.join(REPO, 'f27-pilot', 'src', 'pilot-identity.js'));
const T = require(path.join(REPO, 'f28-origin', 'src', 'lsplugin-transform.js'));

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const manifestPath = path.join(STATIC, ID.MANIFEST_FILE);
const built = fs.existsSync(manifestPath);
const SKIP = built ? false : 'static/ does not currently hold the origin experiment build';
test('an accepted or experimental build must be present', () => {
  assert.ok(built || fs.existsSync(path.join(STATIC, ACCEPTED.MANIFEST_FILE)));
});
const manifest = () => JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

test('the compiled main bundle is the one the manifest describes', { skip: SKIP }, () => {
  const m = manifest();
  const buf = fs.readFileSync(path.join(STATIC, ID.MAIN_BUNDLE));
  assert.strictEqual(sha256(buf), m.artifacts[ID.MAIN_BUNDLE].sha256);
  assert.strictEqual(buf.length, m.artifacts[ID.MAIN_BUNDLE].bytes);
});

test('BOTH closure defines applied — the guards and the experiment', { skip: SKIP }, () => {
  const m = manifest();
  assert.strictEqual(m.closureDefines['electron.pilot/PILOT'], true);
  assert.strictEqual(m.closureDefines['electron.origin-experiment/ORIGIN_EXPERIMENT'], true);

  const bundle = fs.readFileSync(path.join(STATIC, ID.MAIN_BUNDLE), 'utf8');
  assert.ok(bundle.includes(ID.ACTIVE_MARKER), 'the guards must be compiled in');
  assert.ok(!bundle.includes(ID.INERT_MARKER), 'the inert branch must not survive');
  assert.ok(bundle.includes('lsp://logseq.com/'),
    'the experimental application origin must be in the compiled bundle');
});

test('the shipped plugin host is the TRANSFORMED bundle', { skip: SKIP }, () => {
  const shipped = fs.readFileSync(path.join(STATIC, 'js', 'lsplugin.core.js'), 'utf8');
  assert.ok(shipped.includes(T.REPLACEMENT),
    'the shipped bundle must carry the experimental condition');
  assert.ok(!shipped.includes(T.ANCHOR),
    'and must not still carry the original one');
  const m = manifest();
  assert.strictEqual(m.experiment.pluginHostBundle.sha256,
                     sha256(Buffer.from(shipped)),
                     'the manifest must describe the bundle that actually shipped');
});

test('the committed production plugin host bundle was NOT modified', { skip: SKIP }, () => {
  const prod = fs.readFileSync(path.join(REPO, 'resources', 'js', 'lsplugin.core.js'), 'utf8');
  assert.ok(prod.includes(T.ANCHOR),
    'resources/js/lsplugin.core.js must still carry the original condition');
  assert.ok(!prod.includes(T.REPLACEMENT));
  const m = manifest();
  assert.strictEqual(m.experiment.pluginHostBundle.productionSha256, sha256(Buffer.from(prod)));
  assert.notStrictEqual(m.experiment.pluginHostBundle.sha256,
                        m.experiment.pluginHostBundle.productionSha256);
});

test('the shipped identity is the EXPERIMENT identity, not the accepted build\'s',
  { skip: SKIP }, () => {
    const shipped = require(path.join(STATIC, 'pilot-identity.js'));
    assert.strictEqual(shipped.PRODUCT_NAME, ID.PRODUCT_NAME);
    assert.strictEqual(shipped.STATE_DIR, ID.STATE_DIR);
    assert.notStrictEqual(shipped.PRODUCT_NAME, ACCEPTED.PRODUCT_NAME);
    assert.notStrictEqual(shipped.PRODUCT_NAME, PILOT_ID.PRODUCT_NAME);
    assert.strictEqual(manifest().productName, ID.PRODUCT_NAME);
  });

test('the built application directory passes its own preflight', { skip: SKIP }, () => {
  const v = require(path.join(STATIC, 'pilot-preflight.js')).verify(STATIC);
  assert.ok(v.ok, `${v.reason}: ${v.detail}`);
  assert.strictEqual(v.manifest.productName, ID.PRODUCT_NAME);
});

test('the guard entry files are the PILOT sources, byte for byte', { skip: SKIP }, () => {
  for (const f of ['pilot-main.js', 'pilot-preflight.js', 'pilot-isolation.js', 'pilot-boundary.js']) {
    const a = fs.readFileSync(path.join(REPO, 'f27-pilot', 'src', f));
    const b = fs.readFileSync(path.join(STATIC, f));
    assert.strictEqual(sha256(a), sha256(b), `${f} must ship unchanged from the pilot source`);
  }
});

test('packaging is aimed away from the accepted package', { skip: SKIP }, () => {
  const forge = require(path.join(STATIC, 'forge.config.js'));
  assert.ok(path.resolve(forge.outDir).endsWith(path.join('out-originexp')),
    `outDir ${forge.outDir} must not be the accepted build's out/`);
  assert.strictEqual(forge.packagerConfig.appBundleId, ID.BUNDLE_ID);
  assert.deepStrictEqual(forge.makers, []);
  assert.deepStrictEqual(forge.publishers, []);
  assert.ok(!forge.packagerConfig.osxSign);
  assert.ok(!forge.packagerConfig.protocols,
    'the experiment must not claim an OS protocol handler');
});

test('the manifest says plainly that this is a candidate', { skip: SKIP }, () => {
  const m = manifest();
  assert.strictEqual(m.experiment.kind, 'origin');
  assert.strictEqual(m.experiment.appOrigin, 'lsp://logseq.com');
  assert.strictEqual(m.experiment.pluginOrigin, 'lsp://logseq.io');
  assert.match(m.experiment.note, /CANDIDATE ONLY/);
});

// Active equivalents for every accepted-build identity assertion skipped while
// static/ holds the experiment. Source/renderer feature assertions still run.
test('experiment startup artifacts, identity and renderer provenance are verified', { skip: SKIP }, () => {
  const m = manifest();
  for (const f of ['pilot-main.js', 'pilot-preflight.js', 'pilot-isolation.js', 'pilot-identity.js', 'pilot-boundary.js']) {
    assert.ok(m.artifacts[f], f);
    assert.strictEqual(sha256(fs.readFileSync(path.join(STATIC, f))), m.artifacts[f].sha256, f);
  }
  const shipped = require(path.join(STATIC, 'pilot-identity.js'));
  for (const k of ['SCHEMA', 'PRODUCT_NAME', 'BUNDLE_ID', 'PACKAGE_NAME', 'STATE_DIR', 'OWNERSHIP_MARKER']) {
    assert.strictEqual(shipped[k], ID[k], k);
    for (const other of [ACCEPTED, PILOT_ID]) assert.notStrictEqual(shipped[k], other[k], k);
  }
  for (const k of ['ACTIVE_MARKER', 'INERT_MARKER', 'GRAPH_ROOT_SEGMENTS', 'BOUNDARY_SCHEMA', 'BOUNDARY_FILE']) {
    assert.deepStrictEqual(shipped[k], PILOT_ID[k], k);
  }
  assert.ok(require(path.join(STATIC, 'pilot-preflight.js')).verify(STATIC).checks.length >= 10);
  assert.notStrictEqual(m.builtFrom.rendererRevision, '5b34566ca');
  assert.strictEqual(m.builtFrom.branch, 'feature/f28-reference-paths');
  assert.strictEqual(m.rendererBuild.rebuiltHere, true);
  assert.strictEqual(m.rendererBuild.mode, 'compile');
  assert.strictEqual(m.rendererBuild.telemetryDefinesPresent, false);
  assert.strictEqual(m.schema, ID.SCHEMA);
  const head = fs.readFileSync(path.join(STATIC, 'js/main.js'), 'utf8').slice(0, 4096);
  assert.ok(head.includes('"frontend.config.REVISION":"' + m.builtFrom.rendererRevision + '"'));
  assert.ok(head.includes("CLOSURE_BASE_PATH = '" + m.rendererBuild.closureBasePath + "'"));
  assert.strictEqual(m.rendererBuild.closureBasePath, '/static/js/cljs-runtime/');
  assert.doesNotMatch(head.match(/var CLOSURE_DEFINES = (\{[^}]*\})/)[1], /sentry|posthog/i);
  const forge = require(path.join(STATIC, 'forge.config.js'));
  assert.strictEqual(path.resolve(forge.outDir), path.resolve(REPO, '..', 'out-originexp'));
  assert.ok(!forge.packagerConfig.osxNotarize);
});
