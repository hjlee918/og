'use strict';
//
// The FEATURE build's own identity and integrity checks.
//
// Two tests in the accepted pilot suite are about "the real built application
// directory in this checkout":
//
//   guards.test.js    'the compiled pilot bundle is the one the manifest describes'
//   preflight.test.js 'the real built application directory passes its own preflight'
//
// In THIS checkout that directory holds the feature build, not a pilot build,
// so those two are skipped by `scripts/run-feature-tests.js` — by name, in one
// visible place — and replaced here. The pilot test files themselves are NOT
// modified: they remain exactly right for a pilot build, including their pin on
// the accepted renderer revision `5b34566ca`, which this build must NOT satisfy
// and is asserted below to not satisfy.
//
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = path.resolve(__dirname, '..', '..');
const STATIC = path.join(REPO, 'static');
const ID = require(path.join(REPO, 'f27-inline', 'src', 'feature-identity.js'));
const PILOT_ID = require(path.join(REPO, 'f27-pilot', 'src', 'pilot-identity.js'));

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const manifestPath = path.join(STATIC, ID.MANIFEST_FILE);
const built = fs.existsSync(manifestPath);

function manifest() {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

test('a feature build is present in static/', () => {
  assert.ok(built,
    `no feature build present at ${manifestPath}; run f27-inline/scripts/build-feature.js first`);
});

test('the compiled main bundle is the one the manifest describes', { skip: !built }, () => {
  const m = manifest();
  const buf = fs.readFileSync(path.join(STATIC, ID.MAIN_BUNDLE));
  assert.strictEqual(sha256(buf), m.artifacts[ID.MAIN_BUNDLE].sha256);
  assert.strictEqual(buf.length, m.artifacts[ID.MAIN_BUNDLE].bytes);
  assert.strictEqual(m.closureDefines['electron.pilot/PILOT'], true);
});

test('every entry file that participates in startup is covered by the manifest',
  { skip: !built }, () => {
    const m = manifest();
    for (const f of ['pilot-main.js', 'pilot-preflight.js', 'pilot-isolation.js',
                     'pilot-identity.js', 'pilot-boundary.js']) {
      assert.ok(m.artifacts[f], `artifact not covered: ${f}`);
      const buf = fs.readFileSync(path.join(STATIC, f));
      assert.strictEqual(sha256(buf), m.artifacts[f].sha256, `${f} does not match the manifest`);
    }
  });

test('the built application directory passes its own preflight', { skip: !built }, () => {
  // Loaded from static/, so it resolves the identity that actually ships.
  const preflight = require(path.join(STATIC, 'pilot-preflight.js'));
  const v = preflight.verify(STATIC);
  assert.strictEqual(v.ok, true, `${v.reason}: ${v.detail}`);
  assert.ok(v.checks.length >= 10);
});

test('the shipped guard entry is the PILOT source, byte for byte', { skip: !built }, () => {
  for (const f of ['pilot-main.js', 'pilot-preflight.js', 'pilot-isolation.js',
                   'pilot-boundary.js']) {
    const shipped = fs.readFileSync(path.join(STATIC, f));
    const source = fs.readFileSync(path.join(REPO, 'f27-pilot', 'src', f));
    assert.strictEqual(sha256(shipped), sha256(source),
      `${f} shipped differs from the pilot source; the guards must be unchanged`);
  }
});

test('the shipped identity is the FEATURE identity and not the pilot\'s', { skip: !built }, () => {
  const shipped = require(path.join(STATIC, 'pilot-identity.js'));
  assert.strictEqual(shipped.PRODUCT_NAME, ID.PRODUCT_NAME);
  assert.strictEqual(shipped.BUNDLE_ID, ID.BUNDLE_ID);
  assert.notStrictEqual(shipped.PRODUCT_NAME, PILOT_ID.PRODUCT_NAME);
  assert.notStrictEqual(shipped.BUNDLE_ID, PILOT_ID.BUNDLE_ID);
  assert.notStrictEqual(shipped.PACKAGE_NAME, PILOT_ID.PACKAGE_NAME);
  assert.notStrictEqual(shipped.STATE_DIR, PILOT_ID.STATE_DIR);
  assert.notStrictEqual(shipped.OWNERSHIP_MARKER, PILOT_ID.OWNERSHIP_MARKER);
  // The guard markers must be IDENTICAL: they come from the same unchanged
  // guard source, and a different literal would mean different guards.
  assert.strictEqual(shipped.ACTIVE_MARKER, PILOT_ID.ACTIVE_MARKER);
  assert.strictEqual(shipped.INERT_MARKER, PILOT_ID.INERT_MARKER);
  assert.deepStrictEqual(shipped.GRAPH_ROOT_SEGMENTS, PILOT_ID.GRAPH_ROOT_SEGMENTS);
  // Likewise the boundary contract, which belongs to the compiled guard. A
  // stale shipped identity fails here rather than at run time, where it costs a
  // whole packaged session to discover.
  assert.strictEqual(shipped.BOUNDARY_SCHEMA, PILOT_ID.BOUNDARY_SCHEMA);
  assert.strictEqual(shipped.BOUNDARY_FILE, PILOT_ID.BOUNDARY_FILE);
});

test('the boundary contract belongs to the COMPILED guard, not to this build', () => {
  // Regression for a defect this batch's first live run found. Renaming the
  // boundary schema here left `graphRoot` nil in the main process, so the
  // application refused every graph path — including the permitted one — and
  // the run could not load its own synthetic graph. The guard failed closed,
  // which is right; the identity was wrong.
  //
  // The literals are read from the guard SOURCE, so this test tracks the guard
  // rather than restating a constant beside it.
  const guard = fs.readFileSync(
    path.join(REPO, 'src', 'electron', 'electron', 'pilot.cljs'), 'utf8');
  const schema = guard.match(/\(def \^:const BOUNDARY-SCHEMA "([^"]+)"\)/);
  const file = guard.match(/\(def \^:const BOUNDARY-FILE "([^"]+)"\)/);
  assert.ok(schema && file, 'could not read the boundary contract from pilot.cljs');

  for (const ID_ of [ID, PILOT_ID]) {
    assert.strictEqual(ID_.BOUNDARY_SCHEMA, schema[1],
      'the boundary schema must be exactly what the compiled guard accepts');
    assert.strictEqual(ID_.BOUNDARY_FILE, file[1],
      'the boundary file name must be exactly what the compiled guard reads');
  }
});

test('this build does not claim to be the accepted pilot renderer', { skip: !built }, () => {
  const m = manifest();
  assert.notStrictEqual(m.builtFrom.rendererRevision, '5b34566ca',
    'this renderer was rebuilt from the feature branch and must not carry the accepted revision');
  assert.strictEqual(m.builtFrom.branch, 'feature/f27-inline-context');
  assert.strictEqual(m.rendererBuild.rebuiltHere, true);
  assert.strictEqual(m.rendererBuild.mode, 'compile');
  assert.strictEqual(m.rendererBuild.telemetryDefinesPresent, false);
  assert.strictEqual(m.schema, ID.SCHEMA);
  assert.notStrictEqual(m.schema, PILOT_ID.SCHEMA);
});

test('the renderer the manifest describes is the renderer on disk', { skip: !built }, () => {
  const m = manifest();
  const head = fs.readFileSync(path.join(STATIC, 'js', 'main.js'), 'utf8').slice(0, 4096);
  assert.match(head, new RegExp(`"frontend\\.config\\.REVISION":"${m.builtFrom.rendererRevision}"`));
  assert.ok(head.includes(`CLOSURE_BASE_PATH = '${m.rendererBuild.closureBasePath}'`));
  assert.strictEqual(m.rendererBuild.closureBasePath, '/static/js/cljs-runtime/',
    'a release build would point at https://asset.logseq.com/static/js');
  assert.doesNotMatch(head.match(/var CLOSURE_DEFINES = (\{[^}]*\})/)[1], /sentry|posthog/i);
});

test('the packaging configuration writes outside every accepted checkout',
  { skip: !built }, () => {
    const forge = require(path.join(STATIC, 'forge.config.js'));
    const out = path.resolve(forge.outDir);
    for (const name of ['f27-slice-1', 'f27-pilot', 'f27-outgoing-context']) {
      assert.ok(!out.split(path.sep).includes(name), `${out} is inside ${name}`);
    }
    assert.ok(out.split(path.sep).includes('f27-inline-context'), out);
    assert.strictEqual(forge.packagerConfig.appBundleId, ID.BUNDLE_ID);
    assert.ok(!forge.packagerConfig.protocols);
    assert.ok(!forge.packagerConfig.osxSign);
    assert.ok(!forge.packagerConfig.osxNotarize);
    assert.strictEqual((forge.makers || []).length, 0);
    assert.strictEqual((forge.publishers || []).length, 0);
  });

test("this build cannot claim the accepted OUTGOING feature build's state either",
  () => {
    // The outgoing checkout's identity module is still in this tree, inherited
    // from the base commit. Both builds are unsigned local artifacts that write
    // into Application Support, so they must be as distinguishable from each
    // other as each is from the accepted pilot.
    const OUT_ID = require(path.join(REPO, 'f27-outgoing', 'src', 'feature-identity.js'));
    for (const k of ['SCHEMA', 'PRODUCT_NAME', 'BUNDLE_ID', 'PACKAGE_NAME',
                     'STATE_DIR', 'OWNERSHIP_MARKER']) {
      assert.notStrictEqual(ID[k], OUT_ID[k], `${k} collides with the outgoing build`);
    }
    // …and the parts that belong to the compiled guard are shared, for the
    // same reason they are shared with the pilot.
    assert.strictEqual(ID.BOUNDARY_SCHEMA, OUT_ID.BOUNDARY_SCHEMA);
    assert.strictEqual(ID.ACTIVE_MARKER, OUT_ID.ACTIVE_MARKER);
  });

test('the inherited outgoing build script refuses to run on this branch', () => {
  // It pins `feature/f27-outgoing-context`, which this checkout is not on. That
  // refusal is why the inherited tooling can be kept in the tree without any
  // chance of it writing this checkout's application directory.
  const src = fs.readFileSync(
    path.join(REPO, 'f27-outgoing', 'scripts', 'build-feature.js'), 'utf8');
  assert.match(src, /const FEATURE_BRANCH = 'feature\/f27-outgoing-context';/);
  const mine = fs.readFileSync(
    path.join(REPO, 'f27-inline', 'scripts', 'build-feature.js'), 'utf8');
  assert.match(mine, /const FEATURE_BRANCH = 'feature\/f27-inline-context';/);
  assert.match(mine, /const PROTECTED_CHECKOUTS = \['f27-slice-1', 'f27-pilot', 'f27-outgoing-context'\];/);
});
