#!/usr/bin/env node
'use strict';
//
// Packages the F27 inline-context feature application with `electron-forge package`.
//
// Never `make`, never `publish`, and never `gulp electronMaker` — that gulp
// task runs a full release recompile and rewrites static/package.json.
//
// Forge's CLI has no --out flag, so the output location comes from `outDir` in
// the forge config. This script asserts the resolved outDir before packaging
// rather than trusting it, and asserts that it is THIS feature clone's `out/`
// and not the accepted pilot's.
//
// The CLI is invoked from the checkout's own node_modules, never through npx,
// so nothing is downloaded implicitly.
//
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const STATIC = path.join(REPO, 'static');
const ID = require(path.join(REPO, 'f27-inline', 'src', 'feature-identity.js'));
const EXPECTED_OUT = path.resolve(REPO, '..', 'out');
const FORGE_CLI = path.join(STATIC, 'node_modules', '@electron-forge', 'cli', 'dist',
                            'electron-forge.js');

function die(msg) { console.error('\n[package-feature] REFUSED: ' + msg + '\n'); process.exit(1); }

if (!fs.existsSync(FORGE_CLI)) die(`electron-forge CLI not found at ${FORGE_CLI}`);

// The accepted pilot's packaged application must never be the target.
for (const name of ['f27-slice-1', 'f27-pilot', 'f27-outgoing-context']) {
  if (EXPECTED_OUT.split(path.sep).includes(name)) {
    die(`the resolved output directory ${EXPECTED_OUT} is inside ${name}`);
  }
}

const pkg = JSON.parse(fs.readFileSync(path.join(STATIC, 'package.json'), 'utf8'));
if (pkg.main !== 'pilot-main.js') die(`static/package.json main is ${pkg.main}, expected pilot-main.js`);
if (pkg.productName !== ID.PRODUCT_NAME) die(`productName is ${pkg.productName}`);

const forge = require(path.join(STATIC, 'forge.config.js'));
if (path.resolve(forge.outDir) !== EXPECTED_OUT) {
  die(`forge outDir resolved to ${forge.outDir}, expected ${EXPECTED_OUT}`);
}
if (forge.packagerConfig.protocols) die('the forge config declares protocols');
if (forge.packagerConfig.osxSign) die('the forge config requests code signing');
if (forge.packagerConfig.osxNotarize) die('the forge config requests notarization');
if (forge.packagerConfig.appBundleId !== ID.BUNDLE_ID) die('unexpected bundle id');
if ((forge.makers || []).length) die('the forge config declares makers');
if ((forge.publishers || []).length) die('the forge config declares publishers');

// The manifest must be present and consistent before anything is copied. Loaded
// from static/, so it verifies against the identity that will actually ship.
const preflight = require(path.join(STATIC, 'pilot-preflight.js'));
const v = preflight.verify(STATIC);
if (!v.ok) die(`the application directory fails its own preflight: ${v.reason} — ${v.detail}`);
if (v.manifest.productName !== ID.PRODUCT_NAME) die('preflight passed against another identity');

console.log(`[package-feature] outDir ${forge.outDir}`);
console.log(`[package-feature] build ${v.manifest.pilotBuildId}`);
console.log('[package-feature] packaging darwin/x64 (unsigned, local only)');

execFileSync(process.execPath,
  [FORGE_CLI, 'package', '--platform=darwin', '--arch=x64'],
  { cwd: STATIC, stdio: 'inherit' });

// @electron/packager names the bundle after packagerConfig.name, not
// productName, so the .app is Logseq-OG-F27-Inline.app while the display name
// inside Info.plist (CFBundleName) is "Logseq OG F27 Inline".
const appPath = path.join(forge.outDir, `${forge.packagerConfig.name}-darwin-x64`,
                          `${forge.packagerConfig.name}.app`);
if (!fs.existsSync(appPath)) {
  const produced = fs.existsSync(forge.outDir) ? fs.readdirSync(forge.outDir) : [];
  die(`expected ${appPath}; out/ contains: ${produced.join(', ') || '(nothing)'}`);
}
console.log(`[package-feature] DONE: ${appPath}`);
