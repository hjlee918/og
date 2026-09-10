'use strict';
//
// THE PROFILE SWAP's fail-closed rules, stated as executable claims.
//
// This module MOVES a directory in the user's Application Support. That is the
// riskiest thing in the batch, so every rule that keeps it safe is asserted
// here against the PRODUCTION module, using synthetic roots under a temporary
// directory. Nothing in this file touches a real profile.
//
// Asserted:
//
//   * a root is moved ONLY when it carries this build's own ownership marker,
//     with a matching schema, bundle id and product name — an unmarked,
//     foreign-marked or malformed directory refuses, and the refusal happens
//     BEFORE anything is renamed;
//   * a symlinked root refuses rather than being renamed through;
//   * the aside name must be free: an existing preserved profile is never
//     overwritten;
//   * restoration keeps this run's fresh root under its own name rather than
//     deleting it, then puts the preserved one back, and verifies the marker
//     it returns is the marker it took;
//   * restoration refuses to write over an occupied root, and says where the
//     preserved profile still is;
//   * when nothing existed before the run, restoration is a no-op that still
//     keeps the fresh root;
//   * nothing is ever deleted: every path this module gives up is still on
//     disk under a stated name.
//
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FP = require(path.join(__dirname, '..', 'checks', 'fresh-profile.js'));
const ID = require(path.join(__dirname, '..', 'src', 'feature-identity.js'));

function tmpHome(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `f28-profile-${label}-`));
}

function makeRoot(home, marker) {
  const { root } = FP.stateRootFor(ID, home);
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(root, 'userData'), { recursive: true });
  fs.writeFileSync(path.join(root, 'userData', 'evidence.txt'), 'earlier run');
  if (marker !== null) {
    fs.writeFileSync(path.join(root, ID.OWNERSHIP_MARKER),
      typeof marker === 'string' ? marker : JSON.stringify(marker, null, 2));
  }
  return root;
}

const GOOD_MARKER = {
  schema: ID.SCHEMA,
  productName: ID.PRODUCT_NAME,
  bundleId: ID.BUNDLE_ID,
  packageName: ID.PACKAGE_NAME,
  createdAt: '2026-09-09T04:06:07.447Z',
};

test('the state root is exactly where pilot-isolation will put it', () => {
  const home = '/somewhere/home';
  const { root, productDir } = FP.stateRootFor(ID, home);
  assert.equal(productDir,
    path.join(home, 'Library', 'Application Support', ID.PRODUCT_NAME));
  assert.equal(root, path.join(productDir, ID.STATE_DIR));
  // And OG's plugins directory inside it, as `electron/configs.cljs` derives it.
  assert.equal(FP.pluginsDirIn(root), path.join(root, 'home', '.logseq-og', 'plugins'));
});

test('an unmarked directory is refused, and nothing is renamed', () => {
  const home = tmpHome('unmarked');
  const root = makeRoot(home, null);
  assert.throws(() => FP.swapAside(ID, { homeOverride: home, stamp: 's1' }),
    (e) => e instanceof FP.ProfileRefusal && /no-marker/.test(e.message));
  assert.ok(fs.existsSync(root), 'the directory is still where it was');
  assert.equal(fs.existsSync(`${root}.preserved-s1`), false);
});

test("a marker belonging to something else is refused", () => {
  const home = tmpHome('foreign');
  const root = makeRoot(home, { ...GOOD_MARKER, bundleId: 'com.example.other' });
  assert.throws(() => FP.swapAside(ID, { homeOverride: home, stamp: 's1' }),
    (e) => e instanceof FP.ProfileRefusal && /marker-mismatch/.test(e.message));
  assert.ok(fs.existsSync(root));
});

test('a malformed marker is refused rather than ignored', () => {
  const home = tmpHome('malformed');
  const root = makeRoot(home, '{ not json');
  assert.throws(() => FP.swapAside(ID, { homeOverride: home, stamp: 's1' }),
    (e) => e instanceof FP.ProfileRefusal && /marker-unparseable/.test(e.message));
  assert.ok(fs.existsSync(root));
});

test('a symlinked root is refused rather than renamed through', () => {
  const home = tmpHome('symlink');
  const real = path.join(home, 'elsewhere');
  fs.mkdirSync(real, { recursive: true });
  fs.writeFileSync(path.join(real, ID.OWNERSHIP_MARKER), JSON.stringify(GOOD_MARKER));
  const { root, productDir } = FP.stateRootFor(ID, home);
  fs.mkdirSync(productDir, { recursive: true });
  fs.symlinkSync(real, root);
  assert.throws(() => FP.swapAside(ID, { homeOverride: home, stamp: 's1' }),
    (e) => e instanceof FP.ProfileRefusal && /symbolic link/.test(e.message));
  assert.ok(fs.existsSync(real));
});

test('an existing preserved profile is never overwritten', () => {
  const home = tmpHome('collide');
  const root = makeRoot(home, GOOD_MARKER);
  fs.mkdirSync(`${root}.preserved-s1`, { recursive: true });
  assert.throws(() => FP.swapAside(ID, { homeOverride: home, stamp: 's1' }),
    (e) => e instanceof FP.ProfileRefusal && /refusing to overwrite a preserved profile/.test(e.message));
  assert.ok(fs.existsSync(root), 'the shared profile is untouched');
});

test('the swap moves the shared profile aside and leaves the root free', () => {
  const home = tmpHome('swap');
  const root = makeRoot(home, GOOD_MARKER);
  const h = FP.swapAside(ID, { homeOverride: home, stamp: 's2' });
  assert.equal(h.preExisting, true);
  assert.equal(h.preserved, `${root}.preserved-s2`);
  assert.equal(fs.existsSync(root), false, 'the next launch creates a fresh root here');
  // Nothing was deleted: the earlier run's evidence moved with it.
  assert.equal(fs.readFileSync(path.join(h.preserved, 'userData', 'evidence.txt'), 'utf8'),
    'earlier run');
});

test('restoration keeps this run\'s fresh root and puts the shared one back', () => {
  const home = tmpHome('restore');
  const root = makeRoot(home, GOOD_MARKER);
  const h = FP.swapAside(ID, { homeOverride: home, stamp: 's3' });

  // A launch would create this.
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, ID.OWNERSHIP_MARKER),
    JSON.stringify({ ...GOOD_MARKER, createdAt: '2026-09-10T00:00:00.000Z' }));
  fs.writeFileSync(path.join(root, 'startup-report.json'), '{}');

  const r = FP.restore(h, { label: 'plugins' });
  assert.equal(r.ok, true, r.notes.join('; '));
  assert.equal(r.restored, true);
  assert.equal(r.kept, `${root}.plugins-s3`);
  // The fresh root's evidence survives under its own name.
  assert.ok(fs.existsSync(path.join(r.kept, 'startup-report.json')));
  // The shared profile is back, and it is the SAME one — the marker proves it.
  assert.equal(r.markerCreatedAt, GOOD_MARKER.createdAt);
  assert.equal(fs.readFileSync(path.join(root, 'userData', 'evidence.txt'), 'utf8'),
    'earlier run');
  assert.equal(fs.existsSync(h.preserved), false, 'the aside name is free again');
});

test('restoration refuses to write over an occupied root and says where the profile is', () => {
  const home = tmpHome('occupied');
  const root = makeRoot(home, GOOD_MARKER);
  const h = FP.swapAside(ID, { homeOverride: home, stamp: 's4' });

  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'startup-report.json'), '{}');
  // Something already occupies the keep name, so the fresh root cannot move.
  fs.mkdirSync(`${root}.plugins-s4`, { recursive: true });

  const r = FP.restore(h, { label: 'plugins' });
  assert.equal(r.ok, false);
  assert.equal(r.restored, false);
  assert.ok(r.notes.some((n) => n.includes(h.preserved)),
    'the report says where the preserved profile still is');
  assert.ok(fs.existsSync(h.preserved), 'and it really is still there, undeleted');
});

test('when no shared profile existed, restoration is a no-op that still keeps the fresh root', () => {
  const home = tmpHome('none');
  const { root } = FP.stateRootFor(ID, home);
  const h = FP.swapAside(ID, { homeOverride: home, stamp: 's5' });
  assert.equal(h.preExisting, false);
  assert.equal(h.preserved, null);

  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'startup-report.json'), '{}');
  const r = FP.restore(h, { label: 'plugins' });
  assert.equal(r.kept, `${root}.plugins-s5`);
  assert.ok(fs.existsSync(path.join(r.kept, 'startup-report.json')));
  assert.ok(r.notes.some((n) => /none existed before this run/.test(n)));
});
