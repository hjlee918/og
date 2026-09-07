'use strict';
//
// Pre-load build identity: every refusal path, and proof that a refusal loads
// no Logseq OG code at all.
//
// The entry is driven as a real child process rather than by calling
// `verify()` in-process, because the property under test is an ORDERING
// property: the refusal has to happen before `require('./electron.js')`. The
// stand-in bundle writes a sentinel file when it is required, so
// `ogInitialised` is an observation of what the process did, not a self-report.
//
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const H = require('./helpers.js');
const preflight = require(path.join(H.SRC, 'pilot-preflight.js'));

function refusesWith(t, reason, mutate) {
  const f = H.makeFixture();
  try {
    mutate(f);
    const r = H.runEntry(f);
    assert.strictEqual(r.ogInitialised, false,
      'the main bundle was required despite a refusal');
    assert.notStrictEqual(r.status, 0, 'process should exit non-zero');
    assert.match(r.stderr, new RegExp(`reason: ${reason}`),
      `expected refusal ${reason}, got:\n${r.stderr}`);
  } finally {
    H.cleanup(f);
  }
}

test('accepts a consistent pilot build and only then loads the bundle', () => {
  const f = H.makeFixture();
  try {
    const r = H.runEntry(f);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.ogInitialised, true);
    assert.match(r.stdout, /build test-build verified/);
  } finally { H.cleanup(f); }
});

test('refuses a missing manifest with zero OG initialization', (t) => {
  refusesWith(t, 'manifest-missing', (f) =>
    fs.rmSync(path.join(f.appDir, H.ID.MANIFEST_FILE)));
});

test('refuses an unparseable manifest', (t) => {
  refusesWith(t, 'manifest-unparseable', (f) =>
    fs.writeFileSync(path.join(f.appDir, H.ID.MANIFEST_FILE), '{ not json'));
});

test('refuses a manifest with the wrong schema', (t) => {
  refusesWith(t, 'manifest-schema-mismatch', (f) =>
    H.writeManifest(f, { schema: 'something-else/9' }));
});

test('refuses a manifest that does not declare a pilot build', (t) => {
  refusesWith(t, 'manifest-not-a-pilot-build', (f) => H.writeManifest(f, { pilot: false }));
});

test('refuses a manifest belonging to a different product', (t) => {
  refusesWith(t, 'identity-mismatch', (f) => H.writeManifest(f, { productName: 'Logseq OG' }));
});

test('refuses a manifest with a different bundle id', (t) => {
  refusesWith(t, 'identity-mismatch', (f) =>
    H.writeManifest(f, { bundleId: 'com.logseq.logseq-og' }));
});

test('refuses when the pilot closure define was not set', (t) => {
  refusesWith(t, 'pilot-define-not-set', (f) =>
    H.writeManifest(f, { closureDefines: { 'electron.pilot/PILOT': false } }));
});

test('refuses a main bundle whose bytes do not match the manifest', (t) => {
  refusesWith(t, 'artifact-hash-mismatch', (f) => {
    H.writeManifest(f);
    const p = path.join(f.appDir, H.ID.MAIN_BUNDLE);
    // same length, different bytes: defeats a size-only check
    const buf = fs.readFileSync(p);
    buf[0] = buf[0] === 0x2f ? 0x20 : 0x2f;
    fs.writeFileSync(p, buf);
  });
});

test('refuses a main bundle of a different size', (t) => {
  refusesWith(t, 'artifact-size-mismatch', (f) => {
    H.writeManifest(f);
    fs.appendFileSync(path.join(f.appDir, H.ID.MAIN_BUNDLE), '\n// appended\n');
  });
});

test('refuses a tampered isolation module riding on a valid bundle hash', (t) => {
  // Same length, different bytes, so this exercises the hash check rather than
  // the size check.
  refusesWith(t, 'artifact-hash-mismatch', (f) => {
    H.writeManifest(f);
    const p = path.join(f.appDir, 'pilot-isolation.js');
    const buf = fs.readFileSync(p);
    const i = buf.indexOf(Buffer.from('const CONFIG_SEED'));
    assert.ok(i > 0, 'anchor for the same-length tamper not found');
    buf[i] = buf[i] === 0x63 ? 0x43 : 0x63;
    fs.writeFileSync(p, buf);
  });
});

test('refuses a manifest that does not cover every entry file', (t) => {
  refusesWith(t, 'manifest-incomplete', (f) => H.writeManifest(f, (m) => {
    delete m.artifacts['pilot-isolation.js'];
    return m;
  }));
});

test('refuses a missing main bundle', (t) => {
  refusesWith(t, 'artifact-missing', (f) =>
    fs.rmSync(path.join(f.appDir, H.ID.MAIN_BUNDLE)));
});

test('refuses an ordinary non-pilot bundle (guard marker absent)', (t) => {
  const f = H.makeFixture({ markerOverride: null });
  try {
    const r = H.runEntry(f);
    assert.strictEqual(r.ogInitialised, false);
    assert.match(r.stderr, /reason: guards-absent-from-bundle/);
  } finally { H.cleanup(f); }
});

test('refuses a bundle that still carries the inert marker', (t) => {
  const f = H.makeFixture({ extraBundleText: `var INERT = ${JSON.stringify(H.ID.INERT_MARKER)};\n` });
  try {
    const r = H.runEntry(f);
    assert.strictEqual(r.ogInitialised, false);
    assert.match(r.stderr, /reason: bundle-carries-inert-marker/);
  } finally { H.cleanup(f); }
});

test('the manifest cannot relax the guard marker test', () => {
  // A manifest that names some other marker must not let a non-pilot bundle
  // through: the literals come from pilot-identity.js, not from the manifest.
  const f = H.makeFixture({ markerOverride: 'NOT-THE-REAL-MARKER' });
  try {
    H.writeManifest(f, { guardMarker: { present: 'NOT-THE-REAL-MARKER', absent: 'x' } });
    const r = H.runEntry(f);
    assert.strictEqual(r.ogInitialised, false);
    assert.match(r.stderr, /reason: guards-absent-from-bundle/);
  } finally { H.cleanup(f); }
});

test('the real built application directory passes its own preflight', () => {
  const STATIC = path.resolve(__dirname, '..', '..', 'static');
  if (!fs.existsSync(path.join(STATIC, H.ID.MANIFEST_FILE))) {
    assert.fail('no pilot build present; run f27-pilot/scripts/build-pilot.js first');
  }
  const v = preflight.verify(STATIC);
  assert.strictEqual(v.ok, true, `${v.reason}: ${v.detail}`);
  assert.ok(v.checks.length >= 10);
});
