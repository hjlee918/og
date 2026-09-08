#!/usr/bin/env node
'use strict';
//
// Reproducible build of the F27 INLINE-CONTEXT feature application.
//
//   node f27-inline/scripts/build-feature.js
//
// HOW THIS DIFFERS FROM THE PILOT BUILD, AND WHY.
//
// `f27-pilot/scripts/build-pilot.js` rebuilds ONLY the Electron main process
// and then MEASURES that all 3,220 accepted renderer artifacts came through
// byte-identical. That is exactly right for the pilot, whose whole claim is
// that it runs the accepted renderer.
//
// This feature changes renderer source, so that claim cannot be made and is not
// attempted. The renderer is rebuilt HERE, in this checkout, and the manifest
// records it as a NEW renderer measured in this build — never as the accepted
// `5b34566ca` artifact. Nothing is written into the accepted checkout: this
// script refuses to run anywhere but this feature clone, on this feature
// branch, and every output path is derived from this clone's own root.
//
// Build settings, and what they are protecting:
//
//   * `yarn gulp:build` first, because its `clean` deletes `./static/**/*`
//     (keeping only `node_modules` and `yarn.lock`) and would otherwise destroy
//     whatever was compiled before it;
//   * `clojure -M:cljs compile app` — COMPILE, not `release`. The `:app`
//     target's `:release` profile switches `:asset-path` to
//     `https://asset.logseq.com/static/js`, which is the hosted-asset shortcut
//     this project has refused throughout. The compiled asset path is asserted
//     below rather than assumed;
//   * `LOGSEQ_SENTRY_DSN` and `LOGSEQ_POSTHOG_TOKEN` are DELETED from the build
//     environment, so the instrumentation closure-defines are absent from the
//     bundle. That absence is asserted below;
//   * `clojure -M:cljs release electron --config-merge` with
//     `electron.pilot/PILOT true`, exactly as the accepted pilot build does, so
//     every main-process guard is compiled in. The guard marker's presence and
//     the inert marker's absence are asserted, and a failed assertion stops the
//     build — no bypass, no downgrade to a warning.
//
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const STATIC = path.join(REPO, 'static');
const SRC = path.join(REPO, 'f27-inline', 'src');
const PILOT_SRC = path.join(REPO, 'f27-pilot', 'src');
const ID = require(path.join(SRC, 'feature-identity.js'));

const FEATURE_BRANCH = 'feature/f27-inline-context';
// Checkouts this build must never write into, by directory name.
const PROTECTED_CHECKOUTS = ['f27-slice-1', 'f27-pilot', 'f27-outgoing-context'];

// The guarded entry is the PILOT's, unchanged. Only the identity module is this
// feature's, and it is shipped under the name those sources require.
const PILOT_ENTRY_FILES = ['pilot-main.js', 'pilot-preflight.js',
                           'pilot-isolation.js', 'pilot-boundary.js'];
const IDENTITY_TARGET = 'pilot-identity.js';
const ENTRY_FILES = PILOT_ENTRY_FILES.concat([IDENTITY_TARGET]);

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const log = (...a) => console.log('[build-feature]', ...a);

function die(msg) {
  console.error('\n[build-feature] REFUSED: ' + msg + '\n');
  process.exit(1);
}

function git(...args) {
  return execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim();
}

// A build environment with the telemetry tokens removed, so their closure
// defines cannot be set by whatever happens to be exported in this shell.
function buildEnv() {
  const env = Object.assign({}, process.env);
  delete env.LOGSEQ_SENTRY_DSN;
  delete env.LOGSEQ_POSTHOG_TOKEN;
  return env;
}

// Hash every renderer artifact this build produced. For the pilot this proves
// "unchanged"; here it is simply the measurement of what this build made, and
// it is what the manifest publishes.
function hashStaticAssets() {
  const skip = new Set(['node_modules']);
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

// ---------------------------------------------------------------- preconditions
log('repo', REPO);

for (const name of PROTECTED_CHECKOUTS) {
  if (path.basename(REPO) === name || REPO.split(path.sep).includes(name)) {
    die(`this looks like the ${name} checkout (${REPO}). The feature build ` +
        'must only ever run in its own clone.');
  }
}

let branch;
try {
  branch = git('rev-parse', '--abbrev-ref', 'HEAD');
} catch (e) {
  die('not a git repository: ' + e.message);
}
if (branch !== FEATURE_BRANCH) {
  die(`branch is ${branch}, expected ${FEATURE_BRANCH}`);
}
const headCommit = git('rev-parse', 'HEAD');
log('branch', branch, 'at', headCommit);

for (const f of PILOT_ENTRY_FILES) {
  if (!fs.existsSync(path.join(PILOT_SRC, f))) {
    die(`the pilot guard source ${f} is missing; this build ships the pilot ` +
        'entry unchanged and will not substitute anything for it');
  }
}
log('pilot guard sources present and used unchanged:', PILOT_ENTRY_FILES.join(', '));

// ---------------------------------------------------------------- renderer
// gulp FIRST: its clean deletes ./static/**/* except node_modules and
// yarn.lock, so anything compiled before it would be destroyed.
log('assembling static/ (yarn gulp:build)');
try {
  execFileSync('yarn', ['gulp:build'], { cwd: REPO, stdio: 'inherit', env: buildEnv() });
} catch (e) {
  die('yarn gulp:build failed (see output above)');
}

log('compiling :app (compile, local assets, telemetry defines absent)');
let started = Date.now();
try {
  execFileSync('clojure', ['-M:cljs', 'compile', 'app'],
               { cwd: REPO, stdio: 'inherit', env: buildEnv() });
} catch (e) {
  die('the renderer build failed (see output above)');
}
log(`renderer built in ${((Date.now() - started) / 1000).toFixed(1)}s`);

const mainJsPath = path.join(STATIC, 'js', 'main.js');
if (!fs.existsSync(mainJsPath)) die('static/js/main.js was not produced');
const mainJsHead = fs.readFileSync(mainJsPath, 'utf8').slice(0, 4096);

const definesMatch = mainJsHead.match(/var CLOSURE_DEFINES = (\{[^}]*\})/);
if (!definesMatch) die('could not read CLOSURE_DEFINES from static/js/main.js');
const defines = definesMatch[1];
if (/sentry|posthog/i.test(defines)) {
  die(`the renderer carries an instrumentation define: ${defines}`);
}
log('telemetry defines absent from the renderer');

const basePathMatch = mainJsHead.match(/CLOSURE_BASE_PATH = '([^']*)'/);
const closureBasePath = basePathMatch ? basePathMatch[1] : null;
if (closureBasePath !== '/static/js/cljs-runtime/') {
  die(`renderer asset path is ${JSON.stringify(closureBasePath)}; expected the ` +
      'local compile-mode path. A release build would point at ' +
      'https://asset.logseq.com/static/js, which this project does not use.');
}
log('renderer assets are local:', closureBasePath);

const revisionMatch = mainJsHead.match(/"frontend\.config\.REVISION":"([^"]*)"/);
const rendererRevision = revisionMatch ? revisionMatch[1] : null;
let describedNow = null;
try { describedNow = git('describe', '--long', '--always', '--dirty'); } catch (e) { /* fine */ }
log('renderer revision', rendererRevision, '(checkout describes as', describedNow + ')');
if (rendererRevision && describedNow && rendererRevision !== describedNow) {
  die(`the renderer reports revision ${rendererRevision} but this checkout ` +
      `describes as ${describedNow}; the build identity would be untrue`);
}

// ---------------------------------------------------------------- main process
const CONFIG_MERGE = '{:closure-defines {electron.pilot/PILOT true}}';
log('compiling :electron (release) with', CONFIG_MERGE);
started = Date.now();
try {
  execFileSync('clojure',
    ['-M:cljs', 'release', 'electron', '--config-merge', CONFIG_MERGE],
    { cwd: REPO, stdio: 'inherit', env: buildEnv() });
} catch (e) {
  die('the ClojureScript release build of the main process failed (see above)');
}
log(`main process built in ${((Date.now() - started) / 1000).toFixed(1)}s`);

const bundlePath = path.join(STATIC, ID.MAIN_BUNDLE);
const bundleText = fs.readFileSync(bundlePath, 'utf8');

if (bundleText.includes('SHADOW_IMPORT_PATH')) {
  die(`${ID.MAIN_BUNDLE} still contains SHADOW_IMPORT_PATH: this is a ` +
      'development loader that depends on .shadow-cljs outside static/, not a ' +
      'self-contained release bundle.');
}
log('main bundle is self-contained (no SHADOW_IMPORT_PATH)');

if (!bundleText.includes(ID.ACTIVE_MARKER)) {
  die(`${ID.MAIN_BUNDLE} does not contain ${ID.ACTIVE_MARKER}; the pilot ` +
      'guards are not compiled in.');
}
if (bundleText.includes(ID.INERT_MARKER)) {
  die(`${ID.MAIN_BUNDLE} still contains ${ID.INERT_MARKER}; the closure define ` +
      'did not take effect or the inert branch survived optimisation.');
}
log('guard marker present, inert marker absent');

// ---------------------------------------------------------------- assemble
for (const f of PILOT_ENTRY_FILES) {
  fs.copyFileSync(path.join(PILOT_SRC, f), path.join(STATIC, f));
}
// The feature's identity, under the name the pilot entry requires.
fs.copyFileSync(path.join(SRC, 'feature-identity.js'), path.join(STATIC, IDENTITY_TARGET));
log('entry files copied:', ENTRY_FILES.join(', '));

fs.copyFileSync(path.join(SRC, 'feature-forge.config.js'), path.join(STATIC, 'forge.config.js'));
log('forge.config.js written from tracked feature source');

const basePkg = JSON.parse(fs.readFileSync(path.join(REPO, 'resources', 'package.json'), 'utf8'));
const pkg = Object.assign({}, basePkg, {
  name: ID.PACKAGE_NAME,
  productName: ID.PRODUCT_NAME,
  version: `${basePkg.version}-f27inline.1`,
  main: 'pilot-main.js',
  description: 'Isolated local F27 inline-context feature build of Logseq OG. Not for distribution.',
});
// `make`/`publish` must not be reachable from the packaged application.
delete pkg.scripts;
fs.writeFileSync(path.join(STATIC, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
log(`package.json: name=${pkg.name} productName="${pkg.productName}" main=${pkg.main}`);

try {
  execFileSync(process.execPath, [path.join(REPO, 'f27-pilot', 'scripts', 'make-icon.js')],
               { stdio: 'inherit' });
} catch (e) {
  die('icon generation failed');
}

// ---------------------------------------------------------------- manifest
const assets = hashStaticAssets();
log(`renderer asset set produced by THIS build: ${assets.size} files`);

const buildId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}`;

const artifacts = {};
for (const f of [ID.MAIN_BUNDLE].concat(ENTRY_FILES)) {
  const buf = fs.readFileSync(path.join(STATIC, f));
  artifacts[f] = { bytes: buf.length, sha256: sha256(buf) };
}

const manifest = {
  schema: ID.SCHEMA,
  // The key `pilot-preflight.js` requires. It means "the main-process guards
  // are compiled in", which is true and is what the closure define below says.
  pilot: true,
  pilotBuildId: buildId,
  productName: ID.PRODUCT_NAME,
  bundleId: ID.BUNDLE_ID,
  packageName: ID.PACKAGE_NAME,
  builtAt: new Date().toISOString(),
  builtFrom: {
    commit: headCommit,
    branch,
    dirty: git('status', '--porcelain').length > 0,
    rendererRevision,
    describedAtBuild: describedNow,
  },
  closureDefines: { 'electron.pilot/PILOT': true },
  buildCommands: [
    'yarn gulp:build',
    'clojure -M:cljs compile app',
    `clojure -M:cljs release electron --config-merge '${CONFIG_MERGE}'`,
  ],
  rendererBuild: {
    rebuiltHere: true,
    mode: 'compile',
    closureBasePath,
    telemetryDefinesPresent: false,
    // Said explicitly so no later reader can mistake this for the pilot's
    // measurement. The accepted pilot's renderer is a DIFFERENT artifact set
    // and this build makes no equivalence claim about it.
    note: 'This renderer was compiled from this feature branch. It is NOT the ' +
          'accepted 5b34566ca renderer artifact set and is not claimed to be.',
  },
  guardMarker: { present: ID.ACTIVE_MARKER, absent: ID.INERT_MARKER },
  guardSources: 'f27-pilot/src (unchanged); identity from f27-inline/src/feature-identity.js',
  artifacts,
  rendererAssetCount: assets.size,
  rendererAssetSetSha256: sha256(Buffer.from(
    [...assets.entries()].map(([k, v]) => `${v}  ${k}`).join('\n'))),
  host: { platform: process.platform, arch: process.arch, node: process.version,
          release: os.release() },
  note: 'Local build consistency, not signed attestation. See pilot-preflight.js.',
};

fs.writeFileSync(path.join(STATIC, ID.MANIFEST_FILE), JSON.stringify(manifest, null, 2) + '\n');
log('manifest written:', buildId);

// The manifest must satisfy the very check the app will run at startup.
//
// `pilot-preflight.js` resolves `./pilot-identity.js` relative to ITS OWN
// directory, so it is loaded from `static/` — where the FEATURE identity was
// just written — and not from the pilot sources, whose identity module belongs
// to the accepted pilot. Loading it from the wrong place would verify this
// build against the pilot's name and pass for the wrong reason.
const shippedPreflight = require(path.join(STATIC, 'pilot-preflight.js'));
const verdict = shippedPreflight.verify(STATIC);
if (!verdict.ok) {
  die(`the freshly built app fails its own startup preflight: ${verdict.reason} — ${verdict.detail}`);
}
if (verdict.manifest.productName !== ID.PRODUCT_NAME) {
  die('the preflight passed against an identity that is not this feature build');
}
log(`preflight self-check passed (${verdict.checks.length} checks), using the shipped identity ` +
    `"${verdict.manifest.productName}"`);
log('DONE');
