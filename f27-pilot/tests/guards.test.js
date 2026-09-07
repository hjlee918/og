'use strict';
//
// The four main-process guards, and the claim that ordinary builds are
// unaffected by them.
//
// The guards are compile-time: each edit sits inside `(if pilot/PILOT ...)`
// where PILOT is a closure-define that is false unless the pilot build sets it.
// So the honest test is not "the guard is dormant" but "the guard is not there
// at all", checked against a real bundle built with the define at its default.
//
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const H = require('./helpers.js');
const ID = H.ID;
const REPO = path.resolve(__dirname, '..', '..');
const PILOT_BUNDLE = path.join(REPO, 'static', ID.MAIN_BUNDLE);
const nonpilot = require(path.join(REPO, 'f27-pilot', 'scripts', 'build-nonpilot-reference.js'));

const read = (p) => fs.readFileSync(p, 'utf8');

// Strings emitted only by the pilot guard branches.
const PILOT_ONLY = [
  ID.ACTIVE_MARKER,
  'skipped setAsDefaultProtocolClient',
  'skipped Deeplink construction',
  'skipped init-auto-updater',
  'pilotRefused',
  'pilot-guard-journal',
];

// Behaviour that must survive in BOTH builds.
const ALWAYS_PRESENT = [
  'setAsDefaultProtocolClient',  // G1 site: still called in ordinary builds
  'check-for-updates',           // G3 channel
  'install-updates',             // G3 channel
  'assets',                      // internal asset protocol
  'lsp',                         // internal plugin protocol
];

test('the pilot bundle carries the guards', () => {
  const t = read(PILOT_BUNDLE);
  for (const s of PILOT_ONLY) {
    assert.ok(t.includes(s), `pilot bundle is missing ${JSON.stringify(s)}`);
  }
  assert.ok(!t.includes(ID.INERT_MARKER), 'pilot bundle carries the inert marker');
});

test('the pilot bundle keeps the internal protocols and the update channels', () => {
  const t = read(PILOT_BUNDLE);
  for (const s of ALWAYS_PRESENT) {
    assert.ok(t.includes(s), `pilot bundle is missing ${JSON.stringify(s)}`);
  }
  // registerFileProtocol is what serves assets:// and lsp://; F27 asset
  // display depends on it and it is deliberately NOT guarded.
  assert.ok(t.includes('registerFileProtocol'));
  assert.ok(t.includes('registerSchemesAsPrivileged'));
});

test('the pilot bundle is a self-contained release bundle', () => {
  const t = read(PILOT_BUNDLE);
  assert.ok(!t.includes('SHADOW_IMPORT_PATH'),
    'the bundle is a development loader that needs .shadow-cljs outside static/');
  assert.ok(!t.includes('/development/f27-slice-1'),
    'the bundle refers to the accepted checkout at runtime');
  assert.ok(!t.includes('/development/f27-pilot'),
    'the bundle embeds an absolute path into the pilot clone');
});

test('an ordinary build contains none of the pilot guard code', { timeout: 600000 }, () => {
  const t = read(nonpilot.build());
  for (const s of PILOT_ONLY) {
    assert.ok(!t.includes(s),
      `an ordinary build contains pilot-only text ${JSON.stringify(s)}`);
  }
  // Not merely absent-because-false: the whole namespace is eliminated.
  assert.ok(!t.includes(ID.INERT_MARKER));
});

test('an ordinary build keeps every behaviour the pilot guards remove',
  { timeout: 600000 }, () => {
    const t = read(nonpilot.build());
    for (const s of ALWAYS_PRESENT) {
      assert.ok(t.includes(s), `ordinary build lost ${JSON.stringify(s)}`);
    }
  });

test('the compiled pilot bundle is the one the manifest describes', () => {
  const m = JSON.parse(read(path.join(REPO, 'static', ID.MANIFEST_FILE)));
  const buf = fs.readFileSync(PILOT_BUNDLE);
  assert.strictEqual(H.sha256(buf), m.artifacts[ID.MAIN_BUNDLE].sha256);
  assert.strictEqual(buf.length, m.artifacts[ID.MAIN_BUNDLE].bytes);
  assert.strictEqual(m.closureDefines['electron.pilot/PILOT'], true);
  assert.strictEqual(m.builtFrom.rendererRevision, '5b34566ca');
});

test('the guard sources keep every change behind the closure define', () => {
  // A reviewable source-level property: nothing in electron/ references the
  // pilot namespace outside a PILOT-conditional, and PILOT defaults to false.
  const pilotNs = read(path.join(REPO, 'src', 'electron', 'electron', 'pilot.cljs'));
  assert.match(pilotNs, /\(goog-define PILOT false\)/,
    'the closure define no longer defaults to false');

  for (const f of ['core.cljs', 'updater.cljs', 'server.cljs']) {
    const src = read(path.join(REPO, 'src', 'electron', 'electron', f));
    const refs = src.split('\n')
      .map((line, i) => [i + 1, line])
      .filter(([, l]) => /pilot\//.test(l) && !/^\s*;/.test(l));
    assert.ok(refs.length > 0, `${f} has no guard`);
    for (const [n, line] of refs) {
      assert.ok(/pilot\/PILOT|pilot\/record!|pilot\/refuse-js/.test(line),
        `${f}:${n} references the pilot namespace in an unexpected way: ${line.trim()}`);
    }
  }
});
