'use strict';
//
// Downstream filesystem access: watchers and recursive copying.
//
// A root check does not protect the children that follow from it, so these
// tests work at two levels:
//
//   POLICY  -- the real boundary module, driven with a spy filesystem, for the
//              paths a watcher actually emits. Every operation the spy records
//              is asserted to be inside the permitted roots: the proof is not
//              "it returned false", it is "nothing outside was read or stated".
//
//   WIRING  -- the boundary being right is useless if the guard is not in front
//              of the operation. These read the shipped ClojureScript and the
//              compiled bundle and assert the guard is positioned before the
//              read, the stat and the probe, that the watcher is told not to
//              follow links, and that recursive copy is refused.
//
// Inert synthetic strings only. No personal path is named, probed or resolved,
// and nothing outside the permitted roots is created.
//
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const B = require('../src/pilot-boundary.js');

const GRAPH = '/synthetic/CloudDocs/Logseq Test';
const RUN = `${GRAPH}/f27-pilot-run-x`;
const STATE = '/synthetic/AppSupport/Logseq OG F27 Pilot/pilot-state';
const RES = '/synthetic/App.app/Contents/Resources/app';
const OUTSIDE_DIR = '/synthetic/pretend-home/PersonalNotes';

const SRC = path.resolve(__dirname, '..', '..', 'src', 'electron', 'electron');
const readSrc = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');

function insidePermitted(p) {
  return [GRAPH, STATE, RES].some((r) => p === r || p.startsWith(r + path.sep));
}

// Records every filesystem touch so "zero outside operations" is measured.
function spyFs(links = {}) {
  const calls = [];
  const known = [GRAPH, RUN, STATE, RES];
  const record = (op, p) => calls.push({ op, path: p });
  const resolve = (p) => {
    if (Object.prototype.hasOwnProperty.call(links, p)) {
      const t = links[p];
      if (t === null) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return t;
    }
    for (const r of known) if (p === r || p.startsWith(r + path.sep)) return p;
    const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e;
  };
  return {
    calls,
    outside: () => calls.filter((c) => !insidePermitted(c.path)),
    realpathSync(p) { record('realpathSync', p); return resolve(p); },
    lstatSync(p) {
      record('lstatSync', p);
      if (Object.prototype.hasOwnProperty.call(links, p)) return { isSymbolicLink: () => true };
      const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e;
    },
    readFileSync(p) { record('readFileSync', p); return 'content'; },
    statSync(p) { record('statSync', p); return { size: 1 }; },
    existsSync(p) { record('existsSync', p); return true; },
  };
}

function boundaryWith(spy) {
  return B.createBoundary({
    roots: {
      graph: { declared: GRAPH, real: GRAPH },
      state: { declared: STATE, real: STATE },
      resources: { declared: RES, real: RES },
    },
    fs: spy,
    path,
  });
}

// The decision publish-file-event! makes, modelled exactly: check first, then
// read content and stat -- or drop the event and touch nothing.
function watcherEvent(boundary, spy, childPath) {
  if (!boundary.permitted(childPath, 'read')) return { published: false };
  spy.readFileSync(childPath);
  spy.statSync(childPath);
  return { published: true };
}

// The delayed unlink probe: guarded before the existence check.
function delayedUnlinkProbe(boundary, spy, childPath) {
  if (!boundary.permitted(childPath, 'read')) return { probed: false };
  spy.existsSync(childPath);
  return { probed: true };
}

// ---------------------------------------------------------------------------
// POLICY -- what the watcher may touch
// ---------------------------------------------------------------------------

test('a watched child inside the graph is read and stated', () => {
  const spy = spyFs();
  const b = boundaryWith(spy);
  assert.strictEqual(watcherEvent(b, spy, `${RUN}/pages/A.md`).published, true);
  assert.deepStrictEqual(spy.outside(), []);
});

test('a child chokidar reached through a link out of the graph is never read', () => {
  const linked = `${RUN}/pages/linked.md`;
  const spy = spyFs({ [linked]: `${OUTSIDE_DIR}/private.md` });
  const b = boundaryWith(spy);
  assert.strictEqual(watcherEvent(b, spy, linked).published, false);
  assert.deepStrictEqual(spy.outside(), [],
    `the watcher touched something outside: ${JSON.stringify(spy.outside())}`);
  assert.strictEqual(spy.calls.filter((c) => c.op === 'readFileSync').length, 0);
  assert.strictEqual(spy.calls.filter((c) => c.op === 'statSync').length, 0);
});

test('an outside child path is refused with ZERO filesystem operations', () => {
  for (const p of [`${OUTSIDE_DIR}/a.md`, '/synthetic/pretend-home/.logseq-og/x',
                   `${GRAPH}/../Elsewhere/a.md`]) {
    const spy = spyFs();
    const b = boundaryWith(spy);
    assert.strictEqual(watcherEvent(b, spy, p).published, false, `${p} was published`);
    assert.deepStrictEqual(spy.calls, [], `${p} caused ${JSON.stringify(spy.calls)}`);
  }
});

test('the delayed unlink probe does not stat an outside path', () => {
  const spy = spyFs();
  const b = boundaryWith(spy);
  assert.strictEqual(delayedUnlinkProbe(b, spy, `${OUTSIDE_DIR}/gone.md`).probed, false);
  assert.deepStrictEqual(spy.calls, []);
  assert.strictEqual(delayedUnlinkProbe(b, spy, `${RUN}/pages/gone.md`).probed, true);
  assert.deepStrictEqual(spy.outside(), []);
});

test('a global-dir child inside the isolated state is allowed, one outside is not', () => {
  const spy = spyFs();
  const b = boundaryWith(spy);
  assert.strictEqual(watcherEvent(b, spy, `${STATE}/home/.logseq-og/config/config.edn`).published, true);
  assert.strictEqual(watcherEvent(b, spy, `${OUTSIDE_DIR}/config.edn`).published, false);
  assert.deepStrictEqual(spy.outside(), []);
});

test('with no graph root configured the watcher publishes no graph child at all', () => {
  const spy = spyFs();
  const b = B.createBoundary({
    roots: { graph: null, state: { declared: STATE, real: STATE }, resources: null },
    fs: spy, path,
  });
  assert.strictEqual(watcherEvent(b, spy, `${RUN}/pages/A.md`).published, false);
  assert.strictEqual(watcherEvent(b, spy, `${STATE}/userData/configs.edn`).published, true);
  assert.deepStrictEqual(spy.outside(), []);
});

// ---------------------------------------------------------------------------
// WIRING -- the guard is in front of the operation, in the shipped source
// ---------------------------------------------------------------------------

test('the watcher checks the child path before reading or stating it', () => {
  const src = readSrc('fs_watcher.cljs');
  const guard = src.indexOf('(pilot/permitted-path? path "read")');
  const read = src.indexOf('(utils/read-file path)');
  const stat = src.indexOf('(utils/fs-stat->clj path)');
  assert.ok(guard > 0, 'no child-path check in publish-file-event!');
  assert.ok(read > 0 && stat > 0, 'the read/stat calls moved; this test needs updating');
  assert.ok(guard < read, 'the child path is read before it is checked');
  assert.ok(guard < stat, 'the child path is stated before it is checked');
});

test('the watcher is told not to follow symbolic links', () => {
  const src = readSrc('fs_watcher.cljs');
  assert.match(src, /pilot\/PILOT \(assoc :followSymlinks false\)/,
    'chokidar would follow links out of the graph by default');
});

test('the delayed unlink probe is guarded in the shipped source', () => {
  const src = readSrc('fs_watcher.cljs');
  const i = src.indexOf('(fs/existsSync path)');
  assert.ok(i > 0, 'the probe moved; this test needs updating');
  const before = src.slice(Math.max(0, i - 400), i);
  assert.match(before, /pilot\/permitted-path\? path "read"/,
    'the delayed existence probe runs without a check');
});

test('watch-dir! checks before the global-dir branch, not inside one arm', () => {
  const src = readSrc('fs_watcher.cljs');
  const guard = src.indexOf('(pilot/guard-fs! ::watch-dir "read" dir)');
  const branch = src.indexOf('(if (:global-dir options)');
  assert.ok(guard > 0 && branch > 0);
  assert.ok(guard < branch,
    'a :global-dir watcher would be created without any check');
});

test('recursive copyDirectory is refused in the pilot rather than guarded at its roots', () => {
  const src = readSrc('handler.cljs');
  const i = src.indexOf('(defmethod handle :copyDirectory');
  assert.ok(i > 0);
  const body = src.slice(i, i + 1600);
  assert.match(body, /\(if pilot\/PILOT\s*\n\s*\(pilot\/refuse-js :copy-directory/,
    'copyDirectory still performs a recursive copy under PILOT');
  assert.ok(body.indexOf('pilot/refuse-js') < body.indexOf('(fs-extra/copy src dest opts)'),
    'the refusal must come before the copy');
});

test('publishing export refuses in PILOT before any dialog or recursive operation', () => {
  const src = readSrc('core.cljs');
  const i = src.indexOf('handle-export-publish-assets');
  const body = src.slice(i, src.indexOf('(defn setup-app-manager!', i));
  assert.match(body, /\(if pilot\/PILOT\s*\(pilot\/refuse-js :export-publish-assets/);
  const refusal = body.indexOf('(pilot/refuse-js :export-publish-assets');
  assert.ok(refusal < body.indexOf('(handler/open-dir-dialog)'), 'dialog precedes refusal');
  assert.ok(refusal < body.indexOf('(publish-export/create-export'), 'export precedes refusal');
});

// ---------------------------------------------------------------------------
// The compiled article, pilot and ordinary
// ---------------------------------------------------------------------------

test('the pilot bundle carries the watcher and copy guards', () => {
  const bundle = fs.readFileSync(path.resolve(__dirname, '..', '..', 'static', 'electron.js'), 'utf8');
  assert.ok(bundle.includes('followSymlinks'), 'followSymlinks is not compiled in');
  assert.ok(bundle.includes('dropped watcher event'), 'the watcher drop path is not compiled in');
  assert.ok(bundle.includes('recursive copy is not available in the pilot'),
    'the copyDirectory refusal is not compiled in');
  assert.ok(bundle.includes('publishing export is not available in the pilot'),
    'the publishing export refusal is not compiled in');
});
