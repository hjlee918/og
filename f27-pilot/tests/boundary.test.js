'use strict';
//
// The graph-data boundary, tested against a MOCKED filesystem.
//
// Two properties are under test:
//
//   ORDERING  -- a path outside the permitted roots is refused BEFORE anything
//                touches the filesystem. Measured by counting calls on the
//                injected fs: a lexical refusal must record zero.
//   FAIL-CLOSED -- anything that prevents the boundary from DETERMINING the
//                answer is a refusal. This is the defect the supervisor
//                reproduced: EACCES on every descendant used to climb to a
//                permitted ancestor and return ok.
//
// No real personal path is ever used, probed or resolved here. Outside paths
// are inert strings under a synthetic pretend-home, and every filesystem answer
// comes from the mock.
//
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const B = require('../src/pilot-boundary.js');

const GRAPH = '/synthetic/CloudDocs/Logseq Test';
const RUN = `${GRAPH}/f27-pilot-run-x`;
const STATE = '/synthetic/AppSupport/Logseq OG F27 Pilot/pilot-state';
const RES = '/synthetic/App.app/Contents/Resources/app';

const OUTSIDE = [
  '/synthetic/pretend-home/CloudDocs/PersonalNotes',
  '/synthetic/pretend-home/.logseq-og',
  '/synthetic/pretend-home/Documents',
  '/etc/passwd',
];

function err(code) { const e = new Error(code); e.code = code; return e; }

// A filesystem that answers only what the test tells it to, and counts calls.
//   links[p]   -> string (realpath result) | Error (thrown) | null (ENOENT)
//   lstats[p]  -> true (exists) | Error | undefined (defaults to ENOENT)
function mockFs(links = {}, lstats = {}) {
  const calls = [];
  const known = [GRAPH, RUN, STATE, RES];
  return {
    calls,
    realpathSync(p) {
      calls.push(['realpathSync', p]);
      if (Object.prototype.hasOwnProperty.call(links, p)) {
        const t = links[p];
        if (t instanceof Error) throw t;
        if (t === null) throw err('ENOENT');
        return t;
      }
      for (const root of known) if (p === root || p.startsWith(root + path.sep)) return p;
      throw err('ENOENT');
    },
    lstatSync(p) {
      calls.push(['lstatSync', p]);
      if (Object.prototype.hasOwnProperty.call(lstats, p)) {
        const t = lstats[p];
        if (t instanceof Error) throw t;
        if (t) return { isSymbolicLink: () => true };
        throw err('ENOENT');
      }
      throw err('ENOENT');
    },
  };
}

function make(links, lstats, categories) {
  const fs = mockFs(links, lstats);
  const roots = Object.assign({
    graph: { declared: GRAPH, real: GRAPH },
    state: { declared: STATE, real: STATE },
    resources: { declared: RES, real: RES },
  }, categories || {});
  return { fs, b: B.createBoundary({ roots, fs, path }) };
}

// ---------------------------------------------------------------------------
// 1. FAIL CLOSED -- the supervisor's reproduction and its neighbours
// ---------------------------------------------------------------------------

test('EACCES on every descendant is refused, not climbed to a permitted ancestor', () => {
  // The reported reproduction: only the root resolves; everything below throws
  // EACCES. The old code returned ok:true for the leaf.
  const { b } = make({
    [`${RUN}/data.md`]: err('EACCES'),
    [RUN]: err('EACCES'),
    [GRAPH]: GRAPH,
  });
  const v = b.check(`${RUN}/data.md`, 'read');
  assert.strictEqual(v.ok, false, 'an unreadable descendant was treated as permitted');
  assert.strictEqual(v.stage, 'canonical');
  assert.strictEqual(v.code, 'EACCES');
});

test('ELOOP, EIO, EPERM and ENAMETOOLONG all refuse rather than climb', () => {
  for (const code of ['ELOOP', 'EIO', 'EPERM', 'ENAMETOOLONG']) {
    const { b } = make({ [`${RUN}/x`]: err(code) });
    const v = b.check(`${RUN}/x`, 'read');
    assert.strictEqual(v.ok, false, `${code} was permitted`);
    assert.strictEqual(v.code, code);
  }
});

test('a dangling symlink is refused, not mistaken for a safe missing file', () => {
  // realpath says ENOENT, but the entry is really there as a broken link.
  const { b } = make({ [`${RUN}/dangling`]: null }, { [`${RUN}/dangling`]: true });
  const v = b.check(`${RUN}/dangling`, 'read');
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.code, 'EDANGLING');
});

test('an lstat error other than absence also refuses', () => {
  const { b } = make({ [`${RUN}/x`]: null }, { [`${RUN}/x`]: err('EACCES') });
  const v = b.check(`${RUN}/x`, 'read');
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.code, 'EACCES');
});

test('a genuinely absent file inside the root is still permitted (a creation target)', () => {
  const { b } = make({ [`${RUN}/pages/New.md`]: null, [`${RUN}/pages`]: null });
  const v = b.check(`${RUN}/pages/New.md`, 'write');
  assert.strictEqual(v.ok, true, JSON.stringify(v));
  assert.strictEqual(v.real, `${RUN}/pages/New.md`);
});

test('a root that cannot be resolved is dropped, not kept at its declared value', () => {
  const fs = mockFs({ [GRAPH]: err('EACCES') });
  const b = B.boundaryFromCategories({ graph: GRAPH, state: STATE, resources: RES }, fs, path);
  assert.deepStrictEqual(b.dropped().map((d) => d.category), ['graph']);
  assert.strictEqual(b.rootFor('graph'), null);
  const v = b.check(`${RUN}/pages/A.md`, 'graph-select');
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.stage, 'config');
  // state still works, so the application keeps running
  assert.strictEqual(b.permitted(`${STATE}/userData/configs.edn`, 'state'), true);
});

// ---------------------------------------------------------------------------
// 2. SEPARATE POLICIES
// ---------------------------------------------------------------------------

test('graph selection permits only a test-owned subfolder of the graph root', () => {
  const { b } = make();
  assert.strictEqual(b.permitted(RUN, 'graph-select'), true);
  assert.strictEqual(b.permitted(`${RUN}/nested`, 'graph-select'), true);
});

test('graph selection refuses the shared root itself', () => {
  const { b } = make();
  const v = b.check(GRAPH, 'graph-select');
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.stage, 'lexical');
  assert.match(v.reason, /root itself is not a graph/);
});

test('graph selection refuses isolated state and bundled resources', () => {
  const { b } = make();
  for (const p of [STATE, `${STATE}/home/.logseq-og`, RES, `${RES}/js/main.js`]) {
    const v = b.check(p, 'graph-select');
    assert.strictEqual(v.ok, false, `${p} passed a graph gate`);
    assert.strictEqual(v.stage, 'lexical');
  }
});

test('with no graph root, every graph operation is denied but state still works', () => {
  const { b } = make(undefined, undefined, { graph: null });
  assert.strictEqual(b.check(`${RUN}/pages/A.md`, 'graph-select').stage, 'config');
  assert.strictEqual(b.check(`${RUN}/pages/A.md`, 'graph-io').stage, 'config');
  assert.strictEqual(b.permitted(`${STATE}/userData/configs.edn`, 'state'), true);
  assert.strictEqual(b.permitted(`${RES}/js/main.js`, 'resource'), true);
  // a read is still confined: the graph category is simply unavailable
  assert.strictEqual(b.permitted(`${RUN}/pages/A.md`, 'read'), false);
});

test('writes never reach bundled resources', () => {
  const { b } = make();
  assert.strictEqual(b.permitted(`${RES}/js/main.js`, 'read'), true);
  assert.strictEqual(b.permitted(`${RES}/js/main.js`, 'write'), false);
  assert.strictEqual(b.permitted(`${RES}/js/main.js`, 'resource'), true);
});

test('state operations are confined to the isolated state root', () => {
  const { b } = make();
  assert.strictEqual(b.permitted(`${STATE}/userData/configs.edn`, 'state'), true);
  assert.strictEqual(b.permitted(`${RUN}/pages/A.md`, 'state'), false);
  assert.strictEqual(b.permitted(`${RES}/js/main.js`, 'state'), false);
});

test('an unknown operation is denied rather than defaulted', () => {
  const { fs, b } = make();
  const v = b.check(`${RUN}/pages/A.md`, 'not-a-policy');
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.stage, 'policy');
  assert.deepStrictEqual(fs.calls, []);
});

// ---------------------------------------------------------------------------
// 3. ORDERING and the classic escapes
// ---------------------------------------------------------------------------

test('every outside path is refused WITHOUT touching the filesystem', () => {
  for (const p of OUTSIDE) {
    for (const op of ['read', 'write', 'graph-select', 'graph-io']) {
      const { fs, b } = make();
      const v = b.check(p, op);
      assert.strictEqual(v.ok, false, `${p} permitted for ${op}`);
      assert.strictEqual(v.stage, 'lexical');
      assert.deepStrictEqual(fs.calls, [], `${p} probed the filesystem before refusal`);
    }
  }
});

test('traversal out of a root is refused before any filesystem access', () => {
  for (const p of [`${GRAPH}/../Elsewhere`, `${RUN}/../../Elsewhere`,
                   `${GRAPH}/./../pretend-home/.logseq-og`, `${RUN}/a/../../../escape`]) {
    const { fs, b } = make();
    const v = b.check(p, 'read');
    assert.strictEqual(v.ok, false, `${p} permitted`);
    assert.strictEqual(v.stage, 'lexical');
    assert.deepStrictEqual(fs.calls, []);
  }
});

test('a sibling whose name merely starts with the root name is refused', () => {
  const { b } = make();
  assert.strictEqual(b.permitted(`${GRAPH}-not-mine/pages/A.md`, 'read'), false);
  assert.strictEqual(b.permitted(`${GRAPH}Extra`, 'graph-select'), false);
});

test('a symlink escaping the root is refused at the canonical stage', () => {
  const escaping = `${RUN}/link`;
  const { fs, b } = make({ [escaping]: '/synthetic/pretend-home/PersonalNotes' });
  const v = b.check(escaping, 'read');
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.stage, 'canonical');
  assert.ok(fs.calls.length > 0);
});

test('a symlinked ancestor is refused even when the leaf does not exist yet', () => {
  const linkDir = `${RUN}/linkdir`;
  const { b } = make({
    [`${linkDir}/pages/A.md`]: null,
    [`${linkDir}/pages`]: null,
    [linkDir]: '/synthetic/pretend-home/PersonalNotes',
  });
  const v = b.check(`${linkDir}/pages/A.md`, 'write');
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.stage, 'canonical');
});

test('a symlink that stays inside the root is permitted', () => {
  const inner = `${RUN}/alias`;
  const { b } = make({ [inner]: `${RUN}/real` });
  assert.strictEqual(b.permitted(inner, 'read'), true);
});

test('rejects non-string and empty input before anything else', () => {
  const { fs, b } = make();
  for (const bad of [null, undefined, '', 42, {}, []]) {
    const v = b.check(bad, 'read');
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.stage, 'input');
  }
  assert.deepStrictEqual(fs.calls, []);
});

test('boundaryFromCategories drops blank roots rather than widening them', () => {
  const fs = mockFs();
  const b = B.boundaryFromCategories({ graph: GRAPH, state: '', resources: null }, fs, path);
  assert.strictEqual(b.permitted(`${RUN}/x`, 'graph-io'), true);
  assert.strictEqual(b.permitted(`${STATE}/x`, 'state'), false);
  assert.strictEqual(b.permitted('/synthetic/pretend-home/x', 'read'), false);
});
