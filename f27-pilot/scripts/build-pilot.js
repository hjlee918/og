#!/usr/bin/env node
'use strict';
//
// Reproducible pilot build.
//
//   node f27-pilot/scripts/build-pilot.js
//
// Rebuilds ONLY the Electron main process, in release mode, with
// `electron.pilot/PILOT` true, and then assembles the pilot application
// directory from tracked sources. The renderer is never rebuilt: `gulp:build`
// is not run (its `clean` deletes ./static/**/* and would destroy the accepted
// renderer artifacts) and the `:app` target is not compiled, so `static/js/**`
// and `static/css/**` stay exactly as they were accepted.
//
// The script refuses to run anywhere but a pilot clone, so it can never write
// into the accepted checkout.
//
// It ends by writing `static/pilot-build-manifest.json`, which is what
// `pilot-preflight.js` verifies at startup before loading anything.
//
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const STATIC = path.join(REPO, 'static');
const SRC = path.join(REPO, 'f27-pilot', 'src');
const ID = require(path.join(SRC, 'pilot-identity.js'));

const PILOT_BRANCH = 'pilot/f27-desktop-pilot';
const ACCEPTED_CHECKOUT_NAME = 'f27-slice-1';

// Files copied verbatim from the tracked pilot sources into the app directory.
const ENTRY_FILES = [
  'pilot-main.js', 'pilot-preflight.js', 'pilot-isolation.js', 'pilot-identity.js',
];

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const log = (...a) => console.log('[build-pilot]', ...a);

function die(msg) {
  console.error('\n[build-pilot] REFUSED: ' + msg + '\n');
  process.exit(1);
}

function git(...args) {
  return execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim();
}

// Hash every renderer artifact -- the complete reused asset set, not just
// main.js and style.css -- so "the renderer was not rebuilt" is a measurement.
function hashStaticAssets() {
  const skip = new Set(['node_modules']);
  // Outputs of the pilot's own main-process build, plus the metadata this
  // script rewrites. Everything else under static/ is accepted renderer
  // artifact and must come through the build byte-identical.
  const replaced = new Set(
    [ID.MAIN_BUNDLE, ID.MAIN_BUNDLE + '.map', ID.MANIFEST_FILE,
     'package.json', 'forge.config.js', 'tests.js']
      .concat(ENTRY_FILES));
  const out = new Map();
  (function walk(dir, rel) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (!rel && (skip.has(e.name) || replaced.has(e.name))) continue;
      if (rel === 'icons' && e.name === 'pilot.icns') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, r);
      else if (e.isFile()) out.set(r, sha256(fs.readFileSync(p)));
    }
  })(STATIC, '');
  return out;
}

function diffMaps(before, after) {
  const changed = [];
  for (const [k, v] of before) {
    if (!after.has(k)) changed.push(`removed ${k}`);
    else if (after.get(k) !== v) changed.push(`modified ${k}`);
  }
  for (const k of after.keys()) if (!before.has(k)) changed.push(`added ${k}`);
  return changed;
}

// ---------------------------------------------------------------- preconditions
log('repo', REPO);

if (path.basename(REPO) === ACCEPTED_CHECKOUT_NAME ||
    REPO.split(path.sep).includes(ACCEPTED_CHECKOUT_NAME)) {
  die(`this looks like the accepted checkout (${REPO}). The pilot build must ` +
      'only ever run in a separate clone.');
}

let branch;
try {
  branch = git('rev-parse', '--abbrev-ref', 'HEAD');
} catch (e) {
  die('not a git repository: ' + e.message);
}
if (branch !== PILOT_BRANCH) {
  die(`branch is ${branch}, expected ${PILOT_BRANCH}`);
}
log('branch', branch, 'at', git('rev-parse', 'HEAD'));

if (!fs.existsSync(path.join(STATIC, 'js', 'main.js'))) {
  die('static/js/main.js is missing; the accepted renderer must be present');
}

const revisionMatch = fs.readFileSync(path.join(STATIC, 'js', 'main.js'), 'utf8')
  .match(/"frontend\.config\.REVISION":"([^"]*)"/);
const rendererRevision = revisionMatch ? revisionMatch[1] : null;
log('renderer revision', rendererRevision);

const before = hashStaticAssets();
log(`renderer asset set: ${before.size} files hashed before the build`);

// ---------------------------------------------------------------- build
const CONFIG_MERGE = '{:closure-defines {electron.pilot/PILOT true}}';
log('compiling :electron (release) with', CONFIG_MERGE);

const started = Date.now();
try {
  execFileSync('clojure',
    ['-M:cljs', 'release', 'electron', '--config-merge', CONFIG_MERGE],
    { cwd: REPO, stdio: 'inherit' });
} catch (e) {
  die('the ClojureScript release build failed (see output above)');
}
log(`build finished in ${((Date.now() - started) / 1000).toFixed(1)}s`);

// ---------------------------------------------------------------- assertions
const bundlePath = path.join(STATIC, ID.MAIN_BUNDLE);
const bundleBuf = fs.readFileSync(bundlePath);
const bundleText = bundleBuf.toString('utf8');

if (bundleText.includes('SHADOW_IMPORT_PATH')) {
  die(`${ID.MAIN_BUNDLE} still contains SHADOW_IMPORT_PATH: this is a ` +
      'development loader that depends on .shadow-cljs outside static/, not a ' +
      'self-contained release bundle.');
}
log('bundle is self-contained (no SHADOW_IMPORT_PATH)');

if (!bundleText.includes(ID.ACTIVE_MARKER)) {
  die(`${ID.MAIN_BUNDLE} does not contain ${ID.ACTIVE_MARKER}; the pilot ` +
      'guards are not compiled in.');
}
if (bundleText.includes(ID.INERT_MARKER)) {
  die(`${ID.MAIN_BUNDLE} still contains ${ID.INERT_MARKER}; the closure define ` +
      'did not take effect or the inert branch survived optimisation.');
}
log('guard marker present, inert marker absent');

const after = hashStaticAssets();
const changed = diffMaps(before, after);
if (changed.length) {
  die('the build modified renderer artifacts, which must stay byte-identical:\n    ' +
      changed.slice(0, 40).join('\n    '));
}
log(`renderer asset set unchanged (${after.size} files)`);

// ---------------------------------------------------------------- assemble
for (const f of ENTRY_FILES) {
  fs.copyFileSync(path.join(SRC, f), path.join(STATIC, f));
}
log('entry files copied:', ENTRY_FILES.join(', '));

fs.copyFileSync(path.join(SRC, 'pilot-forge.config.js'), path.join(STATIC, 'forge.config.js'));
log('forge.config.js written from tracked pilot source');

// package.json is DERIVED from the upstream resources/package.json, so that
// dependency and version changes upstream are inherited rather than forked.
const basePkg = JSON.parse(fs.readFileSync(path.join(REPO, 'resources', 'package.json'), 'utf8'));
const pilotPkg = Object.assign({}, basePkg, {
  name: ID.PACKAGE_NAME,
  productName: ID.PRODUCT_NAME,
  version: `${basePkg.version}-f27pilot.1`,
  main: 'pilot-main.js',
  description: 'Isolated local F27 pilot build of Logseq OG. Not for distribution.',
});
// `make`/`publish` must not be reachable from the packaged application.
delete pilotPkg.scripts;
fs.writeFileSync(path.join(STATIC, 'package.json'), JSON.stringify(pilotPkg, null, 2) + '\n');
log(`package.json: name=${pilotPkg.name} productName="${pilotPkg.productName}" main=${pilotPkg.main}`);

// icon
try {
  execFileSync(process.execPath, [path.join(__dirname, 'make-icon.js')], { stdio: 'inherit' });
} catch (e) {
  die('icon generation failed');
}

// ---------------------------------------------------------------- manifest
const pilotBuildId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}`;

const artifacts = {};
for (const f of [ID.MAIN_BUNDLE].concat(ENTRY_FILES)) {
  const buf = fs.readFileSync(path.join(STATIC, f));
  artifacts[f] = { bytes: buf.length, sha256: sha256(buf) };
}

const manifest = {
  schema: ID.SCHEMA,
  pilot: true,
  pilotBuildId,
  productName: ID.PRODUCT_NAME,
  bundleId: ID.BUNDLE_ID,
  packageName: ID.PACKAGE_NAME,
  builtAt: new Date().toISOString(),
  builtFrom: {
    commit: git('rev-parse', 'HEAD'),
    branch,
    dirty: git('status', '--porcelain').length > 0,
    rendererRevision,
  },
  closureDefines: { 'electron.pilot/PILOT': true },
  buildCommand: `clojure -M:cljs release electron --config-merge '${CONFIG_MERGE}'`,
  guardMarker: { present: ID.ACTIVE_MARKER, absent: ID.INERT_MARKER },
  artifacts,
  rendererAssetCount: after.size,
  rendererAssetSetSha256: sha256(Buffer.from(
    [...after.entries()].map(([k, v]) => `${v}  ${k}`).join('\n'))),
  host: { platform: process.platform, arch: process.arch, node: process.version,
          release: os.release() },
  note: 'Local build consistency, not signed attestation. See pilot-preflight.js.',
};

fs.writeFileSync(path.join(STATIC, ID.MANIFEST_FILE), JSON.stringify(manifest, null, 2) + '\n');
log('manifest written:', pilotBuildId);

// The manifest must satisfy the very check the app will run at startup.
const preflight = require(path.join(SRC, 'pilot-preflight.js'));
const verdict = preflight.verify(STATIC);
if (!verdict.ok) {
  die(`the freshly built app fails its own startup preflight: ${verdict.reason} — ${verdict.detail}`);
}
log(`preflight self-check passed (${verdict.checks.length} checks)`);
log('DONE');
