'use strict';
//
// Fixture builder for the pilot entry tests.
//
// Each fixture is a throwaway directory that looks like the packaged
// application directory: the four tracked entry files, a stand-in for the
// compiled main bundle, a build manifest, and a fake `electron` module so the
// entry can be driven under plain node.
//
// The stand-in main bundle writes a sentinel file the moment it is required.
// That is how "zero OG initialization" is measured: not by trusting a counter,
// but by asserting the file the bundle would have created does not exist.
//
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const SRC = path.resolve(__dirname, '..', 'src');
const ID = require(path.join(SRC, 'pilot-identity.js'));

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const ENTRY_FILES = ['pilot-main.js', 'pilot-preflight.js', 'pilot-isolation.js',
                     'pilot-identity.js', 'pilot-boundary.js'];

const SENTINEL = 'OG-INITIALISED.sentinel';

function makeFixture(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f27-pilot-test-'));
  const appDir = path.join(dir, 'app');
  const home = path.join(dir, 'home');
  const appData = path.join(dir, 'appData');
  fs.mkdirSync(appDir);
  fs.mkdirSync(home);
  fs.mkdirSync(appData);

  for (const f of ENTRY_FILES) fs.copyFileSync(path.join(SRC, f), path.join(appDir, f));

  const marker = opts.markerOverride === undefined ? ID.ACTIVE_MARKER : opts.markerOverride;
  const bundle =
    "'use strict';\n" +
    '// stand-in main bundle\n' +
    (marker === null ? '' : 'var MARKER = ' + JSON.stringify(marker) + ';\n') +
    (opts.extraBundleText || '') +
    "require('fs').writeFileSync(require('path').join(__dirname, " +
      JSON.stringify(SENTINEL) + "), 'loaded\\n');\n";
  fs.writeFileSync(path.join(appDir, ID.MAIN_BUNDLE), bundle);

  const nm = path.join(appDir, 'node_modules', 'electron');
  fs.mkdirSync(nm, { recursive: true });
  fs.writeFileSync(path.join(nm, 'package.json'),
    JSON.stringify({ name: 'electron', version: '0.0.0-test', main: 'index.js' }));
  fs.writeFileSync(path.join(nm, 'index.js'), FAKE_ELECTRON
    .replace('__APPDATA__', JSON.stringify(appData))
    .replace('__HOME__', JSON.stringify(home))
    .replace('__TEMP__', JSON.stringify(path.join(dir, 'temp'))));

  const fixture = { dir, appDir, home, appData, sentinel: path.join(appDir, SENTINEL) };
  if (opts.manifest !== false) writeManifest(fixture, opts.manifestPatch);
  return fixture;
}

const FAKE_ELECTRON = `
'use strict';
const fs = require('fs'), path = require('path');
const state = { name: 'stub', paths: { appData: __APPDATA__, home: __HOME__, temp: __TEMP__ } };
fs.mkdirSync(state.paths.temp, { recursive: true });
const IGNORE_SETPATH = process.env.PILOT_TEST_IGNORE_SETPATH === '1';
module.exports = {
  app: {
    setName(n) { state.name = n; },
    getName() { return state.name; },
    getPath(n) {
      if (state.paths[n]) return state.paths[n];
      if (n === 'userData' || n === 'sessionData') return path.join(state.paths.appData, state.name);
      if (n === 'logs') return path.join(state.paths.home, 'Library', 'Logs', state.name);
      if (n === 'crashDumps') return path.join(state.paths.appData, state.name, 'Crashpad');
      if (n === 'exe' || n === 'module') return process.execPath;
      if (n === 'recent') { const e = new Error('not available'); e.code = 'ENOTSUP'; throw e; }
      return path.join(state.paths.home, n);
    },
    setPath(n, p) { if (!IGNORE_SETPATH) state.paths[n] = p; },
    setAppLogsPath(p) { if (!IGNORE_SETPATH) state.paths.logs = p; },
    exit(c) { process.exit(c); },
  },
};
`;

function writeManifest(fixture, patch) {
  const artifacts = {};
  for (const f of [ID.MAIN_BUNDLE].concat(ENTRY_FILES)) {
    const buf = fs.readFileSync(path.join(fixture.appDir, f));
    artifacts[f] = { bytes: buf.length, sha256: sha256(buf) };
  }
  let m = {
    schema: ID.SCHEMA,
    pilot: true,
    pilotBuildId: 'test-build',
    productName: ID.PRODUCT_NAME,
    bundleId: ID.BUNDLE_ID,
    packageName: ID.PACKAGE_NAME,
    builtAt: new Date().toISOString(),
    closureDefines: { 'electron.pilot/PILOT': true },
    guardMarker: { present: ID.ACTIVE_MARKER, absent: ID.INERT_MARKER },
    artifacts,
  };
  if (typeof patch === 'function') m = patch(m) || m;
  else if (patch) Object.assign(m, patch);
  fs.writeFileSync(path.join(fixture.appDir, ID.MANIFEST_FILE),
    JSON.stringify(m, null, 2) + '\n');
  return m;
}

function runEntry(fixture, env = {}) {
  let status = 0, stdout = '', stderr = '';
  try {
    stdout = execFileSync(process.execPath, [path.join(fixture.appDir, 'pilot-main.js')], {
      encoding: 'utf8',
      env: Object.assign({}, process.env, env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    status = e.status === undefined ? -1 : e.status;
    stdout = e.stdout || '';
    stderr = e.stderr || '';
  }
  return { status, stdout, stderr, ogInitialised: fs.existsSync(fixture.sentinel) };
}

function cleanup(fixture) {
  try { fs.rmSync(fixture.dir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
}

module.exports = { makeFixture, writeManifest, runEntry, cleanup, sha256, ID, SRC,
                   ENTRY_FILES, SENTINEL };
