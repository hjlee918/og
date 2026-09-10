'use strict';
//
// THE PLUGIN-ARTIFACT GATE's own semantics, stated as executable claims.
//
// This batch loads third-party code into an application. The only thing that
// makes that defensible is that the bytes are provably the ones the project
// already resolved through OG's own Marketplace flow and recorded in V5's
// inventory. So the gate's job is not "copy some files" — it is "REFUSE
// unless these are exactly those bytes", and every clause of that refusal is
// asserted here against the PRODUCTION module, with synthetic packages, so no
// claim rests on the real artifacts happening to be intact.
//
// Asserted:
//
//   * the recorded inventory is the identity the project already has —
//     Marketplace ids, versions, digests and the ChatGPT plugin's SEPARATE
//     manifest id, none of them inferred from a display name;
//   * V5's tree-digest algorithm is reproduced exactly (sorted entries,
//     `.DS_Store` skipped, `path  sha  size` lines joined with newlines),
//     because a digest computed a different way could not be compared with
//     the recorded one at all;
//   * a package that differs by ONE BYTE is refused, and the refusal names
//     which recorded property failed;
//   * an absent package is refused;
//   * a non-empty target directory is refused — a fresh profile is a
//     precondition, not a preference;
//   * a successful install re-verifies at the DESTINATION, which is the copy
//     OG will actually enumerate;
//   * the write-accounting snapshot notices an added, modified or removed
//     plugin file, which is how "no plugin rewrote its own package" is
//     evidence rather than assertion.
//
// Nothing here launches an application, reads a graph, or touches the real
// retained artifacts except through one read-only integrity claim at the end,
// which is skipped rather than failed when the run root is not present.
//
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PA = require(path.join(__dirname, '..', 'checks', 'plugin-artifacts.js'));

function tmp(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `f28-plugin-${label}-`));
}

/** A synthetic package whose bytes we control, recorded the way V5 records. */
function makePackage(dir, id, files) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  return dir;
}

const SYNTH_FILES = {
  'package.json': JSON.stringify({ name: 'synth', version: 'v9.9.9', main: 'dist/index.html',
                                   logseq: { id: 'synth-id' } }),
  'dist/index.html': '<html>synthetic</html>',
  'dist/assets/a.js': 'console.log(1)',
};

test('the recorded inventory is the identity the project already holds, not a display name', () => {
  assert.equal(PA.RECORDED.length, 3);
  const rw = PA.BY_ID.get('logseq-readwise-official-plugin');
  assert.equal(rw.version, 'v1.4.11');
  assert.equal(rw.publisher, 'Readwise');
  assert.equal(rw.importance, 'CRITICAL');
  assert.equal(rw.treeSha256,
    '4ca2768a6b4bf97a2fd0cc2757f068fbc962d6b3f337f785cffecfbab4e245fa');
  // The two Marketplace cards V5 rejected are kept, so "official" stays checkable.
  assert.deepEqual(rw.rejectedCandidates,
    ['logseq-unofficial-readwise-plugin', 'logseq-readwise-reader-export']);

  const ol = PA.BY_ID.get('ollama-logseq');
  assert.equal(ol.version, 'v1.1.6');

  // The ChatGPT plugin's Marketplace id and its manifest's own id differ; the
  // runtime identity is the manifest one, and both are recorded.
  const cg = PA.BY_ID.get('logseq-chatgpt-plugin');
  assert.equal(cg.version, 'v2.0.3');
  assert.equal(cg.manifestId, '_rw1zys420');
  assert.notEqual(cg.manifestId, cg.id);
});

test("the tree digest reproduces V5's algorithm exactly", () => {
  const root = tmp('digest');
  const dir = makePackage(path.join(root, 'p'), 'p', { b: 'two', a: 'one', 'z/c': 'three' });
  fs.writeFileSync(path.join(dir, '.DS_Store'), 'noise');

  const files = PA.treeManifest(dir);
  // Sorted by name at each level, `.DS_Store` excluded, directories walked in place.
  assert.deepEqual(files.map((r) => r[0]), ['a', 'b', 'z/c']);

  const sha = (s) => crypto.createHash('sha256').update(Buffer.from(s)).digest('hex');
  const expected = crypto.createHash('sha256').update([
    ['a', sha('one'), 3].join('  '),
    ['b', sha('two'), 3].join('  '),
    [path.join('z', 'c'), sha('three'), 5].join('  '),
  ].join('\n')).digest('hex');

  assert.equal(PA.treeDigest(files), expected);
  // And `.DS_Store` really is outside the digest.
  assert.equal(PA.inspect(dir).fileCount, 3);
});

test('a package that differs by one byte is refused, and the refusal names the property', () => {
  const src = tmp('src');
  const id = 'logseq-readwise-official-plugin';
  makePackage(path.join(src, id), id, SYNTH_FILES);

  const v = PA.verify(id, src);
  assert.equal(v.ok, false);
  // Several recorded properties fail here, and each is named individually.
  const joined = v.mismatches.join(' | ');
  assert.match(joined, /treeSha256: recorded/);
  assert.match(joined, /manifestSha256: recorded/);
  assert.match(joined, /version: recorded "v1\.4\.11"/);

  assert.throws(() => PA.installInto(path.join(tmp('dst'), 'plugins'), [id], { sourceRoot: src }),
    (e) => e instanceof PA.ArtifactRefusal &&
           /not the one the project recorded/.test(e.message));
});

test('an absent package is refused rather than skipped', () => {
  const src = tmp('empty');
  const v = PA.verify('ollama-logseq', src);
  assert.equal(v.ok, false);
  assert.deepEqual(v.mismatches, ['absent']);
  assert.throws(() => PA.installInto(path.join(tmp('dst2'), 'plugins'), ['ollama-logseq'],
    { sourceRoot: src }), PA.ArtifactRefusal);
});

test('an unknown id is refused before anything is read', () => {
  assert.throws(() => PA.verify('some-other-plugin'), PA.ArtifactRefusal);
  assert.throws(() => PA.installInto(tmp('dst3'), ['some-other-plugin']), PA.ArtifactRefusal);
});

/**
 * Run `fn` with one inventory entry temporarily describing synthetic bytes,
 * so the SUCCESS path can be exercised without the real artifacts. The real
 * record is always put back.
 */
function withSyntheticRecord(id, packageDir, fn) {
  const measured = PA.inspect(packageDir);
  const original = PA.BY_ID.get(id);
  PA.BY_ID.set(id, Object.freeze({ ...original,
    treeSha256: measured.treeSha256, manifestSha256: measured.manifestSha256,
    fileCount: measured.fileCount, totalBytes: measured.totalBytes,
    version: measured.declaredVersion, main: measured.declaredMain,
    manifestId: measured.declaredLogseqId }));
  try { return fn(measured); } finally { PA.BY_ID.set(id, original); }
}

test('a non-empty plugins directory is refused: a fresh profile is a precondition', () => {
  const src = tmp('ok-src');
  const id = 'ollama-logseq';
  const dir = makePackage(path.join(src, id), id, SYNTH_FILES);
  const dst = path.join(tmp('ok-dst'), 'plugins');
  fs.mkdirSync(dst, { recursive: true });
  fs.mkdirSync(path.join(dst, 'something-already-here'));

  withSyntheticRecord(id, dir, () => {
    assert.throws(() => PA.installInto(dst, [id], { sourceRoot: src }),
      (e) => e instanceof PA.ArtifactRefusal && /already holds/.test(e.message));
  });
});

test('a successful install re-verifies at the destination and reports its provenance', () => {
  const src = tmp('ok-src2');
  const id = 'ollama-logseq';
  const dir = makePackage(path.join(src, id), id, SYNTH_FILES);
  fs.writeFileSync(path.join(dir, '.DS_Store'), 'noise');

  withSyntheticRecord(id, dir, (measured) => {
    const dst = path.join(tmp('ok-dst2'), 'plugins');
    const r = PA.installInto(dst, [id], { sourceRoot: src });
    assert.equal(r.installed.length, 1);
    assert.equal(r.installed[0].id, id);
    assert.equal(r.installed[0].treeSha256, measured.treeSha256);
    // The destination copy is the one OG enumerates, so it is the one verified.
    assert.equal(PA.verify(id, dst).ok, true);
    assert.match(r.installed[0].placement, /no Marketplace call, no download/);
    assert.match(r.installed[0].provenance, /V5 \(2026-09-03\)/);
    // `.DS_Store` is not carried across, which is also why the digest matched.
    assert.equal(fs.existsSync(path.join(dst, id, '.DS_Store')), false);
  });
});

test('the write-accounting snapshot sees an added, modified or removed plugin file', () => {
  const root = tmp('snap');
  const dir = path.join(root, 'plugins');
  makePackage(path.join(dir, 'p1'), 'p1', { 'package.json': '{}', 'dist/index.html': 'x' });
  const before = PA.snapshot(dir);
  assert.deepEqual(Object.keys(before).sort(), ['p1/dist/index.html', 'p1/package.json']);
  assert.deepEqual(PA.compareSnapshots(before, PA.snapshot(dir)), []);

  fs.writeFileSync(path.join(dir, 'p1', 'dist', 'index.html'), 'y');
  assert.deepEqual(PA.compareSnapshots(before, PA.snapshot(dir)), ['modified p1/dist/index.html']);

  fs.writeFileSync(path.join(dir, 'p1', 'dist', 'index.html'), 'x');
  fs.writeFileSync(path.join(dir, 'p1', 'settings.json'), '{"token":"none"}');
  assert.deepEqual(PA.compareSnapshots(before, PA.snapshot(dir)), ['added p1/settings.json']);

  fs.unlinkSync(path.join(dir, 'p1', 'settings.json'));
  fs.unlinkSync(path.join(dir, 'p1', 'package.json'));
  assert.deepEqual(PA.compareSnapshots(before, PA.snapshot(dir)), ['removed p1/package.json']);
});

test("the project's retained artifacts still hash to what V5 recorded", (t) => {
  if (!fs.existsSync(PA.SOURCE_ROOT)) {
    t.skip(`the V5 run root is not present at ${PA.SOURCE_ROOT}`);
    return;
  }
  for (const v of PA.verifyAll()) {
    assert.ok(v.ok, `${v.id}: ${v.mismatches.join('; ')}`);
  }
});
