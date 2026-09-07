'use strict';
//
// Directory ownership and path containment.
//
// The rule being tested: the pilot claims a state root only when it genuinely
// created it, adopts an existing one only on its own valid marker, and refuses
// everything else without writing anything into the directory in question.
//
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const H = require('./helpers.js');
const isolation = require(path.join(H.SRC, 'pilot-isolation.js'));
const ID = H.ID;

// A minimal stand-in for Electron's `app`, with the same path semantics the
// real one has before `ready`.
function fakeApp(appData, home, opts = {}) {
  const paths = { appData, home, temp: path.join(appData, '..', 'temp') };
  fs.mkdirSync(paths.temp, { recursive: true });
  let name = 'stub';
  return {
    _paths: paths,
    setName(n) { name = n; },
    getName() { return name; },
    getPath(n) {
      if (paths[n]) return paths[n];
      if (n === 'userData' || n === 'sessionData') return path.join(appData, name);
      if (n === 'logs') return path.join(home, 'Library', 'Logs', name);
      if (n === 'crashDumps') return path.join(appData, name, 'Crashpad');
      if (n === 'exe' || n === 'module') return process.execPath;
      if (n === 'recent') { const e = new Error('nope'); e.code = 'ENOTSUP'; throw e; }
      return path.join(home, n);
    },
    setPath(n, p) { if (!opts.ignoreSetPath) paths[n] = p; },
    setAppLogsPath(p) { if (!opts.ignoreSetPath) paths.logs = p; },
  };
}

function scratch() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'f27-pilot-iso-')));
  const appData = path.join(dir, 'Application Support');
  const home = path.join(dir, 'home');
  fs.mkdirSync(appData);
  fs.mkdirSync(home);
  return { dir, appData, home,
           productDir: path.join(appData, ID.PRODUCT_NAME),
           root: path.join(appData, ID.PRODUCT_NAME, ID.STATE_DIR) };
}

function establish(s, opts = {}) {
  return isolation.establish({ app: fakeApp(s.appData, s.home, opts), pilotBuildId: 'test' });
}

function refuses(s, reason, opts = {}) {
  assert.throws(() => establish(s, opts), (e) => {
    assert.strictEqual(e.reason, reason, `expected ${reason}, got ${e.reason}: ${e.detail}`);
    return true;
  });
}

test('creates a new root, writes ownership evidence and isolates every path', () => {
  const s = scratch();
  const out = establish(s);
  assert.strictEqual(out.root, s.root);

  const marker = JSON.parse(fs.readFileSync(path.join(s.root, ID.OWNERSHIP_MARKER), 'utf8'));
  assert.strictEqual(marker.bundleId, ID.BUNDLE_ID);
  assert.strictEqual(marker.productName, ID.PRODUCT_NAME);
  assert.strictEqual(marker.schema, ID.SCHEMA);

  const rep = out.report;
  assert.strictEqual(rep.ok, true);
  assert.strictEqual(rep.ownership.state, 'created');
  assert.deepStrictEqual(rep.refusedPaths, []);

  for (const n of ID.ISOLATED_PATHS.concat(['logs'])) {
    assert.strictEqual(rep.audit[n].insideRoot, true, `${n} is not inside the root`);
  }
  assert.ok(fs.existsSync(path.join(s.root, ID.STARTUP_REPORT)));
});

test('the derived dot-root is inside the pilot root and is not the real one', () => {
  const s = scratch();
  const rep = establish(s).report;
  assert.strictEqual(rep.derived.dotRootIsolated, true);
  assert.notStrictEqual(rep.derived.dotRoot, rep.derived.realDotRoot);
  assert.ok(rep.derived.dotRoot.startsWith(s.root + path.sep));
  // the real home is recorded from the password database, before any override
  assert.strictEqual(rep.realOsIdentity.osUserInfoHome, os.userInfo().homedir);
  assert.notStrictEqual(rep.pathsAfter.home, rep.realOsIdentity.osUserInfoHome);
  assert.notStrictEqual(rep.pathsAfter.home, rep.pathsBefore.home);
});

test('seeds configs.edn with the updater and API server switched off', () => {
  const s = scratch();
  establish(s);
  const cfg = fs.readFileSync(path.join(s.root, 'userData', 'configs.edn'), 'utf8');
  assert.match(cfg, /:auto-update false/);
  assert.match(cfg, /:server\/autostart false/);
});

test('does not overwrite an existing configs.edn on reuse', () => {
  const s = scratch();
  establish(s);
  const cfgPath = path.join(s.root, 'userData', 'configs.edn');
  fs.writeFileSync(cfgPath, '{:auto-update false, :user-edited true}\n');
  establish(s);
  assert.match(fs.readFileSync(cfgPath, 'utf8'), /:user-edited true/);
});

test('adopts a root it previously created, without rewriting the marker', () => {
  const s = scratch();
  establish(s);
  const markerPath = path.join(s.root, ID.OWNERSHIP_MARKER);
  const before = fs.readFileSync(markerPath);
  const rep = establish(s).report;
  assert.strictEqual(rep.ownership.state, 'reused');
  assert.deepStrictEqual(fs.readFileSync(markerPath), before,
    'the ownership marker was rewritten on reuse');
});

test('refuses an unknown existing directory and writes nothing into it', () => {
  const s = scratch();
  fs.mkdirSync(s.root, { recursive: true });
  fs.writeFileSync(path.join(s.root, 'someone-elses-data.txt'), 'do not touch\n');
  refuses(s, 'unknown-existing-directory');
  assert.deepStrictEqual(fs.readdirSync(s.root), ['someone-elses-data.txt'],
    'the pilot wrote into a directory it does not own');
});

test('refuses an ownership marker belonging to something else', () => {
  const s = scratch();
  fs.mkdirSync(s.root, { recursive: true });
  fs.writeFileSync(path.join(s.root, ID.OWNERSHIP_MARKER), JSON.stringify({
    schema: ID.SCHEMA, productName: 'Logseq OG', bundleId: 'com.logseq.logseq-og',
  }));
  refuses(s, 'ownership-marker-mismatch');
  assert.deepStrictEqual(fs.readdirSync(s.root).sort(), [ID.OWNERSHIP_MARKER]);
});

test('refuses a malformed ownership marker', () => {
  const s = scratch();
  fs.mkdirSync(s.root, { recursive: true });
  fs.writeFileSync(path.join(s.root, ID.OWNERSHIP_MARKER), 'not json at all');
  refuses(s, 'ownership-marker-unparseable');
});

test('refuses a symlinked pilot root', () => {
  const s = scratch();
  const elsewhere = path.join(s.dir, 'elsewhere');
  fs.mkdirSync(elsewhere);
  fs.mkdirSync(s.productDir);
  fs.symlinkSync(elsewhere, s.root);
  refuses(s, 'root-is-symlink');
  assert.deepStrictEqual(fs.readdirSync(elsewhere), [],
    'the pilot wrote through a symlinked root');
});

test('refuses when the root exists as a file', () => {
  const s = scratch();
  fs.mkdirSync(s.productDir);
  fs.writeFileSync(s.root, 'not a directory');
  refuses(s, 'root-not-a-directory');
});

test('refuses a symlinked child of an owned root', () => {
  const s = scratch();
  establish(s);
  const home = path.join(s.root, 'home');
  const elsewhere = path.join(s.dir, 'escape');
  fs.mkdirSync(elsewhere);
  fs.rmSync(home, { recursive: true });
  fs.symlinkSync(elsewhere, home);
  refuses(s, 'child-is-symlink');
});

test('refuses when a child exists as a file', () => {
  const s = scratch();
  establish(s);
  const temp = path.join(s.root, 'temp');
  fs.rmSync(temp, { recursive: true });
  fs.writeFileSync(temp, 'x');
  refuses(s, 'child-not-a-directory');
});

test('refuses when the platform silently ignores setPath', () => {
  // The contingency named in the plan: if Electron ever declines to relocate
  // `home`, the pilot must refuse rather than run against the real one.
  const s = scratch();
  assert.throws(() => establish(s, { ignoreSetPath: true }), (e) => {
    assert.strictEqual(e.reason, 'path-verification-failed');
    assert.match(e.detail, /home/);
    return true;
  });
  // the failure is recorded inside the root, which by then is genuinely owned
  const rep = JSON.parse(fs.readFileSync(path.join(s.root, ID.STARTUP_REPORT), 'utf8'));
  assert.strictEqual(rep.ok, false);
  assert.ok(rep.refusedPaths.length > 0);
});

test('crash dumps are relocated too', () => {
  const s = scratch();
  const rep = establish(s).report;
  assert.strictEqual(rep.audit.crashDumps.insideRoot, true);
  assert.strictEqual(rep.audit.crashDumps.overridden, true);
});

test('the audit covers every documented Electron path name', () => {
  const s = scratch();
  const rep = establish(s).report;
  for (const n of isolation.ALL_PATH_NAMES) {
    assert.ok(Object.prototype.hasOwnProperty.call(rep.audit, n), `missing ${n} from the audit`);
  }
  // paths the pilot deliberately does not relocate are reported, not hidden
  assert.strictEqual(rep.audit.documents.overridden, false);
  assert.strictEqual(rep.audit.downloads.overridden, false);
});

test('a product directory pre-created by Chromium does not block a first start', () => {
  // Chromium's crash handler creates <appData>/<productName>/Crashpad before
  // the entry script runs. That must not be mistaken for someone else's data,
  // and it must not be claimed either: the owned root is a level deeper.
  const s = scratch();
  fs.mkdirSync(path.join(s.productDir, 'Crashpad'), { recursive: true });
  const out = establish(s);
  assert.strictEqual(out.report.ownership.state, 'created');
  assert.strictEqual(out.root, s.root);
  assert.ok(fs.existsSync(path.join(s.productDir, 'Crashpad')),
    'the pre-existing Crashpad directory was disturbed');
  assert.ok(!fs.existsSync(path.join(s.productDir, ID.OWNERSHIP_MARKER)),
    'an ownership marker was written into the product directory');
});

test('refuses a symlinked product directory', () => {
  const s = scratch();
  const elsewhere = path.join(s.dir, 'elsewhere2');
  fs.mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere, s.productDir);
  refuses(s, 'product-dir-is-symlink');
});
