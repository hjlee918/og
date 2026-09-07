'use strict';
//
// The ownership, refusal and archive rules that every preview demonstration
// graph obeys — in ONE place, so there is a single implementation of
// containment rather than one per demonstration graph.
//
// These rules were written for the user demonstration graph and are unchanged
// here; `make-preview-graph.js` and `make-integrated-graph.js` are now two sets
// of NOTES over this one store.
//
// IT NEVER DELETES ANYTHING. A demonstration graph holds ordinary editable
// notes — the preview does not disable OG's editor — so a reader may well have
// changed them on purpose. An existing graph is therefore either left alone or,
// on an explicit reset, MOVED into a dated archive beside it. `build` refuses
// outright if anything is already there.
//
// Every write and every reset validates first that the target really is this
// preview's own graph directory: inside the preview root, reached without
// traversing a symlink, and carrying its generator's own signature.
const fs = require('fs');
const path = require('path');

const PREVIEW_DIR = path.resolve(__dirname, '../../f27-preview');

class PreviewGraphError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'PreviewGraphError';
    this.code = code;
  }
}

// Resolve without requiring the path to exist: realpath the nearest existing
// ancestor, so `..` segments and symlinks cannot be used to escape.
function resolveStrict(p) {
  const abs = path.resolve(p);
  let probe = abs;
  for (;;) {
    if (fs.existsSync(probe)) return path.join(fs.realpathSync(probe), path.relative(probe, abs));
    const parent = path.dirname(probe);
    if (parent === probe) return abs;
    probe = parent;
  }
}

function inside(root, p) {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// The target must sit inside the preview root AND be reachable without passing
// through a symlink, so neither a replaced directory nor a crafted link can
// redirect a write or an archive move somewhere else.
function assertOwnedPath(label, p, root) {
  const abs = path.resolve(p);
  const real = resolveStrict(abs);
  if (real !== abs) {
    throw new PreviewGraphError(
      `${label} is reached through a symbolic link (${abs} resolves to ${real}); refusing to touch it`,
      'SYMLINK'
    );
  }
  const realRoot = resolveStrict(root);
  if (!inside(realRoot, real)) {
    throw new PreviewGraphError(`${label} resolves outside the preview directory (${real})`, 'ESCAPE');
  }
  return real;
}

const entriesOf = (d) => fs.readdirSync(d).filter((n) => n !== '.DS_Store');

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

// ---------------------------------------------------------------------------
// One demonstration graph: its own directory name, ownership proof, expected
// contents and note-writing function, over the shared rules above.
// ---------------------------------------------------------------------------
function createStore(spec) {
  const {
    dirName,
    marker,
    signature,
    markerText,
    expectedPages,
    expectedAssets = 0,
    config,
    write,
    previewDir: defaultPreviewDir = PREVIEW_DIR,
  } = spec;

  function layout(root) {
    const dir = path.resolve(root || defaultPreviewDir);
    return {
      previewDir: dir,
      graphRoot: path.join(dir, 'graph'),
      graph: path.join(dir, 'graph', dirName),
      archiveRoot: path.join(dir, 'graph-archive'),
    };
  }

  // What is actually on disk, decided before anything is written.
  function inspect(root) {
    const L = layout(root);
    assertOwnedPath('the demonstration graph', L.graph, L.previewDir);

    if (!fs.existsSync(L.graph)) return { status: 'absent', graph: L.graph, detail: 'nothing is there yet' };
    const st = fs.lstatSync(L.graph);
    if (st.isSymbolicLink()) {
      throw new PreviewGraphError('the demonstration graph path is a symbolic link; refusing to touch it', 'SYMLINK');
    }
    if (!st.isDirectory()) {
      return { status: 'foreign', graph: L.graph, detail: 'a file exists where the graph directory should be' };
    }
    if (entriesOf(L.graph).length === 0) return { status: 'empty', graph: L.graph, detail: 'the directory is empty' };

    const configPath = path.join(L.graph, 'logseq/config.edn');
    let signed = false;
    if (fs.existsSync(configPath)) {
      try {
        signed = fs.readFileSync(configPath, 'utf8').includes(signature);
      } catch (e) {
        signed = false;
      }
    }
    const marked = fs.existsSync(path.join(L.graph, marker));
    if (!signed && !marked) {
      return {
        status: 'foreign',
        graph: L.graph,
        detail: "it carries neither this generator's signature nor its marker file, so it is not this preview's graph",
      };
    }

    const pagesDir = path.join(L.graph, 'pages');
    const assetsDir = path.join(L.graph, 'assets');
    const pages = fs.existsSync(pagesDir) ? entriesOf(pagesDir).filter((f) => f.endsWith('.md')) : [];
    const assets = fs.existsSync(assetsDir) ? entriesOf(assetsDir) : [];
    const missing = [];
    if (!fs.existsSync(configPath)) missing.push('logseq/config.edn is missing');
    if (pages.length < expectedPages) missing.push(`${pages.length} of ${expectedPages} pages present`);
    if (assets.length < expectedAssets) missing.push(`${assets.length} of ${expectedAssets} files present`);
    if (missing.length) {
      return {
        status: 'owned-incomplete',
        graph: L.graph,
        pages: pages.length,
        assets: assets.length,
        detail: missing.join('; '),
      };
    }
    return {
      status: 'owned-complete',
      graph: L.graph,
      pages: pages.length,
      assets: assets.length,
      detail: expectedAssets
        ? `${pages.length} pages and ${assets.length} files present`
        : `${pages.length} pages present`,
    };
  }

  // Archive, never delete. A rename inside the preview directory, so the notes
  // survive intact and the reader is told exactly where they went.
  function archive(root) {
    const L = layout(root);
    assertOwnedPath('the demonstration graph', L.graph, L.previewDir);
    const state = inspect(root);
    if (state.status === 'absent' || state.status === 'empty') return null;
    if (state.status === 'foreign') {
      throw new PreviewGraphError(
        `${L.graph} exists but ${state.detail}. Nothing there will be moved or deleted. ` +
          'Move it aside yourself if you want a fresh demonstration graph.',
        'FOREIGN'
      );
    }
    const s = stamp(new Date());
    let dest = path.join(L.archiveRoot, `${dirName}-${s}`);
    let n = 2;
    while (fs.existsSync(dest)) dest = path.join(L.archiveRoot, `${dirName}-${s}-${n++}`);
    assertOwnedPath('the archive destination', dest, L.previewDir);
    fs.mkdirSync(L.archiveRoot, { recursive: true });
    fs.renameSync(L.graph, dest);
    return dest;
  }

  // Create. Refuses if anything is already there; `reset` archives first.
  function build(opts = {}) {
    const root = opts.root;
    const L = layout(root);
    assertOwnedPath('the demonstration graph', L.graph, L.previewDir);

    const state = inspect(root);
    let archived = null;
    if (state.status !== 'absent' && state.status !== 'empty') {
      if (!opts.reset) {
        throw new PreviewGraphError(
          `${L.graph} already exists (${state.detail}). It will not be overwritten or deleted. ` +
            'Use --reset to move it into a dated archive first.',
          state.status === 'foreign' ? 'FOREIGN' : 'EXISTS'
        );
      }
      archived = archive(root);
    }

    const pagesDir = path.join(L.graph, 'pages');
    const assetsDir = path.join(L.graph, 'assets');
    fs.mkdirSync(pagesDir, { recursive: true });
    fs.mkdirSync(path.join(L.graph, 'logseq'), { recursive: true });
    if (expectedAssets) fs.mkdirSync(assetsDir, { recursive: true });

    fs.writeFileSync(path.join(L.graph, marker), markerText, 'utf8');
    fs.writeFileSync(path.join(L.graph, 'logseq/config.edn'), config, 'utf8');
    fs.writeFileSync(path.join(L.graph, 'logseq/custom.css'), '/* preview graph */\n', 'utf8');

    write({
      graph: L.graph,
      pagesDir,
      assetsDir,
      // A page, written with its trailing blank lines trimmed.
      writePage: (name, body) =>
        fs.writeFileSync(path.join(pagesDir, name), String(body).replace(/\n+$/, '') + '\n', 'utf8'),
      // A file in the graph's own asset directory. The name is a plain file
      // name: nothing here composes a path from anything a note says.
      writeAsset: (name, data) => {
        if (name.includes('/') || name.includes('\\') || name === '..' || name === '.') {
          throw new PreviewGraphError(`an asset name must be a plain file name, got "${name}"`, 'NAME');
        }
        fs.writeFileSync(path.join(assetsDir, name), data);
      },
    });

    const files = entriesOf(pagesDir).sort();
    const assets = expectedAssets ? entriesOf(assetsDir).sort() : [];
    return { files, assets, archived, graph: L.graph };
  }

  return {
    layout,
    inspect,
    archive,
    build,
    assertOwnedPath,
    PreviewGraphError,
    PREVIEW_DIR: defaultPreviewDir,
    GRAPH_DIR_NAME: dirName,
    MARKER: marker,
    SIGNATURE: signature,
    EXPECTED_PAGES: expectedPages,
    EXPECTED_ASSETS: expectedAssets,
  };
}

module.exports = { createStore, assertOwnedPath, resolveStrict, inside, entriesOf, stamp, PreviewGraphError, PREVIEW_DIR };
