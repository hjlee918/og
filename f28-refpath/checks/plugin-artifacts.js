'use strict';
//
// THE THREE INVENTORIED PLUGIN PACKAGES, AS PROJECT-OWNED PUBLIC ARTIFACTS.
//
// Identity is taken from the project's OWN existing record — V5's plugin
// inventory (`project-notes/baseline/V5_PLUGINS_LOCAL_EXTERNAL_FILES.md`,
// section 5) — never from a display name. V5 resolved each identity through
// OG's own Marketplace metadata flow and installed each through OG's ordinary
// Install action, then recorded the installed package's tree digest, manifest
// digest, file count and byte count. Those recorded values are reproduced
// below as `RECORDED`, and this module REFUSES to hand a package to a run
// unless the bytes on disk still hash to them.
//
// WHY A FILESYSTEM PLACEMENT IS THE HONEST OFFLINE MECHANISM, AND WHAT IT IS
// NOT. OG discovers installed plugins by ENUMERATING ITS OWN PLUGINS
// DIRECTORY: `electron.utils/get-ls-default-plugins` lists every non-dot
// subdirectory of `<dot-root>/plugins` and hands the list to
// `frontend.handler.plugin`, which passes it to
// `LSPluginCore.register(metas, true)`. Placing an already-downloaded package
// there is therefore the state OG's own Install action produces, reached
// without a network request, a Marketplace call or a download. It is NOT an
// in-app Marketplace install, and nothing here claims the Install ACTION was
// exercised: the provenance is V5's Marketplace install, carried forward and
// re-proved by hash. That distinction is recorded in every report this module
// feeds.
//
// The algorithm below is V5's, deliberately unchanged, so the digests are
// comparable at all: entries sorted by name, `.DS_Store` skipped, each file
// rendered as `<relative path>  <sha256>  <bytes>` and the lines joined with
// newlines, then hashed. See `<V5ROOT>/scripts/v5lib.js` `treeManifest`.
//
// NOTHING HERE READS A PERSONAL APP PROFILE. The source is V5's own
// task-owned `plugin-all` profile inside this project's generated run root —
// public third-party plugin code that the project downloaded and retained.
// V5's other two plugin profiles no longer hold their packages (its recorded
// uninstall check removed them) and its `plugin-readwise` profile's last graph
// was a private working copy, so `plugin-all` is the ONLY source this module
// will read, and it reads the package directories alone.
//
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const PROJECT = path.resolve(REPO, '..', '..', '..');

/** V5's retained packages: the only source this module reads. */
const SOURCE_ROOT = path.join(PROJECT, 'generated', 'og-baseline', '2026-09-03-v5-01',
                              'profiles', 'plugin-all', 'home', '.logseq-og', 'plugins');

/**
 * What V5 recorded at install time, per plugin, verbatim.
 *
 * `importance` and `informalName` are the user's own framing, kept so a report
 * can say which plugin was the priority without re-deriving it.
 */
const RECORDED = Object.freeze([
  Object.freeze({
    id: 'logseq-readwise-official-plugin',
    informalName: 'the official Readwise plugin',
    title: 'Readwise Official Plugin',
    publisher: 'Readwise',
    version: 'v1.4.11',
    importance: 'CRITICAL',
    manifestId: 'logseq-readwise-official-plugin',
    main: 'dist/index.html',
    treeSha256: '4ca2768a6b4bf97a2fd0cc2757f068fbc962d6b3f337f785cffecfbab4e245fa',
    manifestSha256: '327ec6c51bd8dad080b1a2530d5a676a861cca22f203779f4118d8a41e44b97e',
    fileCount: 7,
    totalBytes: 332236,
    // The two Marketplace cards V5 considered and rejected, kept so the
    // "official" choice stays checkable rather than assumed.
    rejectedCandidates: ['logseq-unofficial-readwise-plugin', 'logseq-readwise-reader-export'],
  }),
  Object.freeze({
    id: 'ollama-logseq',
    informalName: 'ollama-logseq',
    title: 'ollama-logseq',
    publisher: 'Omar Magdy',
    version: 'v1.1.6',
    importance: 'OPTIONAL',
    manifestId: 'ollama-logseq',
    main: 'dist/index.html',
    treeSha256: '4a83c5609ee84169b41602d81112c3181afdd7c8a7db03afd1f266057b750b35',
    manifestSha256: '65ae11415c130d6c039146348d8586ef4545bbfacf83ac9ae7bac0b71473fa58',
    fileCount: 6,
    totalBytes: 394981,
    rejectedCandidates: [],
  }),
  Object.freeze({
    id: 'logseq-chatgpt-plugin',
    informalName: 'the previously inventoried Logseq ChatGPT plugin',
    title: 'Logseq ChatGPT Plugin',
    publisher: 'debanjandhar12',
    version: 'v2.0.3',
    importance: 'OPTIONAL',
    // The Marketplace ID and the manifest's own `logseq.id` differ, and V5
    // recorded both. The plugin's RUNTIME identity — the key OG's host uses —
    // is the manifest one.
    manifestId: '_rw1zys420',
    main: 'dist/index.html',
    treeSha256: 'dc051dc6ad6adaa8663377a5d00d823b8e449426779b6110e759b7caaa602230',
    manifestSha256: 'ff8d408014c0b8f76949180e00fe561aef7d65e2d3aad1363b9fe0f2d10fb98f',
    fileCount: 16,
    totalBytes: 16767809,
    rejectedCandidates: [],
  }),
]);

const BY_ID = new Map(RECORDED.map((r) => [r.id, r]));

const PROVENANCE =
  "V5 (2026-09-03) resolved each identity through OG's own Marketplace metadata " +
  'flow and installed it with a single Install click on the exact card, into a ' +
  "task-owned profile; the retained package is byte-identical to that install " +
  'and is re-hashed here before use. This batch performs NO Marketplace call, ' +
  'NO download and NO in-app Install.';

class ArtifactRefusal extends Error {}

const sha256File = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

/** V5's tree manifest, unchanged, so the digests are comparable. */
function treeManifest(dir) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })
                      .sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === '.DS_Store') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push([path.relative(dir, p), sha256File(p), fs.statSync(p).size]);
    }
  })(dir);
  return out;
}

function treeDigest(files) {
  return crypto.createHash('sha256')
    .update(files.map((r) => r.join('  ')).join('\n')).digest('hex');
}

/**
 * Measure one package directory. Reads files; resolves nothing outside `dir`.
 * Returns a measurement, never a verdict — `verify` decides.
 */
function inspect(dir) {
  if (!fs.existsSync(dir)) return { present: false, dir };
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink()) {
    throw new ArtifactRefusal(`${dir} is a symbolic link; refusing to read a package through one`);
  }
  if (!st.isDirectory()) return { present: false, dir, reason: 'not a directory' };
  const files = treeManifest(dir);
  const pj = path.join(dir, 'package.json');
  let manifestSha256 = null;
  let manifest = null;
  if (fs.existsSync(pj)) {
    const raw = fs.readFileSync(pj);
    manifestSha256 = crypto.createHash('sha256').update(raw).digest('hex');
    try { manifest = JSON.parse(raw.toString('utf8')); } catch (e) { manifest = null; }
  }
  return {
    present: true,
    dir,
    fileCount: files.length,
    totalBytes: files.reduce((a, r) => a + r[2], 0),
    treeSha256: treeDigest(files),
    manifestSha256,
    declaredName: manifest ? manifest.name : null,
    declaredVersion: manifest ? manifest.version : null,
    declaredMain: manifest ? manifest.main : null,
    declaredLogseqId: manifest && manifest.logseq ? manifest.logseq.id : null,
  };
}

/**
 * Is what is on disk still exactly what V5 recorded?
 *
 * Every recorded field is compared, not just the tree digest, so a report can
 * say precisely which property failed rather than only that something did.
 */
function verify(id, root = SOURCE_ROOT) {
  const rec = BY_ID.get(id);
  if (!rec) throw new ArtifactRefusal(`${JSON.stringify(id)} is not an inventoried plugin`);
  const got = inspect(path.join(root, id));
  if (!got.present) {
    return { id, ok: false, reason: 'absent', recorded: rec, measured: got, mismatches: ['absent'] };
  }
  const mismatches = [];
  const cmp = (field, want, have) => { if (want !== have) mismatches.push(`${field}: recorded ${JSON.stringify(want)}, measured ${JSON.stringify(have)}`); };
  cmp('treeSha256', rec.treeSha256, got.treeSha256);
  cmp('manifestSha256', rec.manifestSha256, got.manifestSha256);
  cmp('fileCount', rec.fileCount, got.fileCount);
  cmp('totalBytes', rec.totalBytes, got.totalBytes);
  cmp('version', rec.version, got.declaredVersion);
  cmp('main', rec.main, got.declaredMain);
  cmp('manifest logseq.id', rec.manifestId, got.declaredLogseqId);
  return { id, ok: mismatches.length === 0, recorded: rec, measured: got, mismatches };
}

/** Verify every inventoried plugin at `root`. */
function verifyAll(root = SOURCE_ROOT) {
  return RECORDED.map((r) => verify(r.id, root));
}

/** Copy one directory tree, refusing symlinks rather than following them. */
function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name === '.DS_Store') continue;
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isSymbolicLink()) {
      throw new ArtifactRefusal(`${s} is a symbolic link; refusing to copy through one`);
    }
    if (e.isDirectory()) copyTree(s, d);
    else fs.copyFileSync(s, d);
  }
}

/**
 * Place verified packages into a plugins directory OG will enumerate.
 *
 * Refuses unless: every requested package verifies at the source, the target
 * directory is empty (a fresh profile, never a shared one carrying state), and
 * the copy re-verifies at the DESTINATION — which is the digest OG will
 * actually load, and the only one worth reporting.
 */
function installInto(pluginsDir, ids, opts = {}) {
  const root = opts.sourceRoot || SOURCE_ROOT;
  const wanted = ids.map((id) => {
    if (!BY_ID.has(id)) throw new ArtifactRefusal(`${JSON.stringify(id)} is not an inventoried plugin`);
    return id;
  });

  const sourceVerdicts = wanted.map((id) => verify(id, root));
  const bad = sourceVerdicts.filter((v) => !v.ok);
  if (bad.length) {
    throw new ArtifactRefusal(
      'refusing to load a package that is not the one the project recorded: ' +
      bad.map((v) => `${v.id} [${v.mismatches.join('; ')}]`).join(' | '));
  }

  fs.mkdirSync(pluginsDir, { recursive: true });
  const existing = fs.readdirSync(pluginsDir).filter((n) => n !== '.DS_Store');
  if (existing.length) {
    throw new ArtifactRefusal(
      `${pluginsDir} already holds ${JSON.stringify(existing)}; this batch installs only into ` +
      'an empty plugins directory of a fresh profile');
  }

  const installed = [];
  for (const id of wanted) {
    const dst = path.join(pluginsDir, id);
    copyTree(path.join(root, id), dst);
    const after = verify(id, pluginsDir);
    if (!after.ok) {
      throw new ArtifactRefusal(
        `the placed copy of ${id} does not hash to the recorded package: ${after.mismatches.join('; ')}`);
    }
    installed.push({
      id,
      version: after.recorded.version,
      title: after.recorded.title,
      publisher: after.recorded.publisher,
      importance: after.recorded.importance,
      manifestId: after.recorded.manifestId,
      dir: dst,
      treeSha256: after.measured.treeSha256,
      manifestSha256: after.measured.manifestSha256,
      fileCount: after.measured.fileCount,
      totalBytes: after.measured.totalBytes,
      provenance: PROVENANCE,
      placement: 'copied into the fresh profile\'s own plugins directory, which is what ' +
                 'electron.utils/get-ls-default-plugins enumerates; no Marketplace call, ' +
                 'no download, no in-app Install action',
    });
  }
  return { pluginsDir, sourceRoot: root, installed, sourceVerdicts };
}

/**
 * Hash a plugins directory as a flat map, for write accounting.
 * A plugin that rewrote its own package would show up here.
 */
function snapshot(pluginsDir) {
  const out = {};
  if (!fs.existsSync(pluginsDir)) return out;
  for (const id of fs.readdirSync(pluginsDir).filter((n) => n !== '.DS_Store')) {
    const dir = path.join(pluginsDir, id);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const [rel, sha, size] of treeManifest(dir)) out[`${id}/${rel}`] = `${sha}:${size}`;
  }
  return out;
}

/** Files that differ between two `snapshot` readings. */
function compareSnapshots(before, after) {
  const changed = [];
  for (const k of Object.keys(after)) {
    if (!(k in before)) changed.push(`added ${k}`);
    else if (before[k] !== after[k]) changed.push(`modified ${k}`);
  }
  for (const k of Object.keys(before)) if (!(k in after)) changed.push(`removed ${k}`);
  return changed;
}

module.exports = {
  RECORDED, BY_ID, SOURCE_ROOT, PROVENANCE, ArtifactRefusal,
  treeManifest, treeDigest, inspect, verify, verifyAll,
  installInto, snapshot, compareSnapshots,
};
