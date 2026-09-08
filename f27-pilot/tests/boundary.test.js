'use strict';
//
// The graph-data boundary, tested against a MOCKED filesystem.
//
// The property under test is an ordering property, not just an outcome: a path
// outside the permitted roots must be refused BEFORE anything touches the
// filesystem. That is measured by counting calls on the injected fs — a lexical
// refusal must record zero.
//
// No real personal path is ever used, probed or resolved here. Outside paths
// are inert strings under a synthetic pretend-home, and every filesystem answer
// comes from the mock.
//
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const B = require('../src/pilot-boundary.js');

const GRAPH = '/synthetic/Mobile Documents/CloudDocs/Logseq Test';
const STATE = '/synthetic/AppSupport/Logseq OG F27 Pilot/pilot-state';
const RES = '/synthetic/App.app/Contents/Resources/app';

// Inert strings standing in for locations the pilot must never reach. None of
// these is a real path on any machine; nothing here is resolved for real.
const OUTSIDE = [
  '/synthetic/pretend-home/Mobile Documents/CloudDocs/PersonalNotes',
  '/synthetic/pretend-home/.logseq-og',
  '/synthetic/pretend-home/Documents',
  '/Applications/Logseq-OG.app/Contents/Resources/app',
  '/etc/passwd',
];

// A filesystem that answers only what the test tells it to, and counts every
// call so "before any filesystem access" can be asserted rather than assumed.
function mockFs(links = {}) {
  const calls = [];
  return {
    calls,
    realpathSync(p) {
      calls.push(['realpathSync', p]);
      if (Object.prototype.hasOwnProperty.call(links, p)) {
        const target = links[p];
        if (target === null) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
        return target;
      }
      // Default: every path under a known root exists and is its own real path.
      for (const root of [GRAPH, STATE, RES]) {
        if (p === root || p.startsWith(root + path.sep)) return p;
      }
      const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e;
    },
  };
}

function make(links) {
  const fs = mockFs(links);
  const roots = [GRAPH, STATE, RES].map((r) => ({ declared: r, real: r }));
  return { fs, b: B.createBoundary({ roots, fs, path }) };
}

test('permits a graph path inside the permitted root', () => {
  const { b } = make();
  const v = b.check(path.join(GRAPH, 'f27-pilot-run-x', 'pages', 'A.md'));
  assert.strictEqual(v.ok, true, JSON.stringify(v));
});

test('permits isolated state and bundled resources, and nothing wider', () => {
  const { b } = make();
  assert.strictEqual(b.permitted(path.join(STATE, 'home', '.logseq-og', 'graphs')), true);
  assert.strictEqual(b.permitted(path.join(RES, 'js', 'main.js')), true);
  // the parents of the permitted roots are NOT permitted
  assert.strictEqual(b.permitted('/synthetic/AppSupport'), false);
  assert.strictEqual(b.permitted('/synthetic'), false);
  assert.strictEqual(b.permitted('/'), false);
});

test('refuses every outside path WITHOUT touching the filesystem', () => {
  for (const p of OUTSIDE) {
    const { fs, b } = make();
    const v = b.check(p);
    assert.strictEqual(v.ok, false, `${p} was permitted`);
    assert.strictEqual(v.stage, 'lexical', `${p} reached stage ${v.stage}`);
    assert.deepStrictEqual(fs.calls, [],
      `${p} caused filesystem access before being refused: ${JSON.stringify(fs.calls)}`);
  }
});

test('refuses traversal out of a permitted root, before any filesystem access', () => {
  const traversals = [
    path.join(GRAPH, '..', 'Elsewhere'),
    path.join(GRAPH, 'run', '..', '..', 'Elsewhere'),
    `${GRAPH}/../../pretend-home/.logseq-og`,
    `${GRAPH}/./../Elsewhere`,
  ];
  for (const p of traversals) {
    const { fs, b } = make();
    const v = b.check(p);
    assert.strictEqual(v.ok, false, `${p} was permitted`);
    assert.strictEqual(v.stage, 'lexical');
    assert.deepStrictEqual(fs.calls, [], `${p} probed the filesystem first`);
  }
});

test('a sibling whose name merely starts with the root name is refused', () => {
  const { b } = make();
  assert.strictEqual(b.permitted(GRAPH + '-not-mine/pages/A.md'), false);
  assert.strictEqual(b.permitted(GRAPH + 'Extra'), false);
});

test('refuses a symlink that escapes the root, at the canonical stage', () => {
  const escaping = path.join(GRAPH, 'run', 'link');
  const { fs, b } = make({ [escaping]: '/synthetic/pretend-home/PersonalNotes' });
  const v = b.check(escaping);
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.stage, 'canonical');
  assert.match(v.reason, /link/);
  // it did have to consult the filesystem to find that out
  assert.ok(fs.calls.length > 0);
});

test('refuses a symlinked ancestor even when the leaf does not exist yet', () => {
  const linkDir = path.join(GRAPH, 'run', 'linkdir');
  const { b } = make({
    [path.join(linkDir, 'pages', 'A.md')]: null,
    [path.join(linkDir, 'pages')]: null,
    [linkDir]: '/synthetic/pretend-home/PersonalNotes',
  });
  const v = b.check(path.join(linkDir, 'pages', 'A.md'));
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.stage, 'canonical');
});

test('permits a not-yet-created file inside the root', () => {
  const target = path.join(GRAPH, 'run', 'pages', 'New.md');
  const { b } = make({ [target]: null, [path.dirname(target)]: null });
  const v = b.check(target);
  assert.strictEqual(v.ok, true, JSON.stringify(v));
  assert.strictEqual(v.real, target);
});

test('a symlink that stays inside the root is permitted', () => {
  const inner = path.join(GRAPH, 'run', 'alias');
  const { b } = make({ [inner]: path.join(GRAPH, 'run', 'real') });
  assert.strictEqual(b.permitted(inner), true);
});

test('fails closed when no root is configured', () => {
  const fs = mockFs();
  const b = B.createBoundary({ roots: [], fs, path });
  const v = b.check(path.join(GRAPH, 'anything'));
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.stage, 'config');
  assert.deepStrictEqual(fs.calls, []);
});

test('fails closed when the graph root is absent, keeping state and resources', () => {
  // This is the shape the application takes when pilot-boundary.json is missing
  // or malformed: the graph root is simply not among the roots.
  const fs = mockFs();
  const b = B.createBoundary({
    roots: [STATE, RES].map((r) => ({ declared: r, real: r })), fs, path,
  });
  assert.strictEqual(b.permitted(path.join(GRAPH, 'run', 'pages', 'A.md')), false);
  assert.strictEqual(b.permitted(path.join(STATE, 'userData', 'configs.edn')), true);
});

test('rejects non-string and empty input before anything else', () => {
  const { fs, b } = make();
  for (const bad of [null, undefined, '', 42, {}, []]) {
    const v = b.check(bad);
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.stage, 'input');
  }
  assert.deepStrictEqual(fs.calls, []);
});

test('boundaryFromRoots drops blank roots rather than widening them', () => {
  const fs = mockFs();
  const b = B.boundaryFromRoots([null, '', '   ', GRAPH], fs, path);
  assert.strictEqual(b.roots().length, 1);
  assert.strictEqual(b.permitted(path.join(GRAPH, 'x')), true);
  assert.strictEqual(b.permitted('/synthetic/pretend-home/x'), false);
});
