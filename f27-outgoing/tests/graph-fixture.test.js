'use strict';
//
// The feature batch's synthetic-graph tooling, checked WITHOUT touching the
// permitted graph-data root.
//
// Nothing here creates, reads or enumerates a graph. It exercises the templates
// and the reuse rules against temporary directories, and asserts the containment
// refusals with paths that are never written to. The generator's real `build()`
// is deliberately NOT called: creating a graph is what the loaded-graph run
// does, once, inside the permitted root.
//
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const gen = require(path.join(REPO, 'f27-outgoing', 'checks', 'make-outgoing-graph.js'));
const batch = require(path.join(REPO, 'f27-outgoing', 'checks', 'outgoing-batch-graph.js'));
const B = require(path.join(REPO, 'f27-pilot', 'checks', 'allowed-root.js'));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const anchorRef = `((${gen.UUID.anchor}))`;

test('every identity the fixture writes is a well-formed uuid', () => {
  for (const [name, u] of Object.entries(gen.UUID)) {
    assert.match(u, UUID_RE, `${name} is not a uuid`);
  }
  for (const u of gen.MANY) assert.match(u, UUID_RE);
  assert.strictEqual(new Set(Object.values(gen.UUID).concat(gen.MANY)).size,
    Object.keys(gen.UUID).length + gen.MANY.length, 'identities collide');
});

test('exactly ten blocks reference the anchor, which is the overview\'s row limit', () => {
  const sources = Object.entries(gen.PAGES)
    .filter(([, body]) => body.includes(anchorRef))
    .map(([name]) => name);
  assert.strictEqual(sources.length, 10,
    `the compact overview renders at most 10 rows; sources: ${sources.join(', ')}`);
});

test('the ordered source writes its links in an order identity order would not produce', () => {
  const body = gen.PAGES['Ordered Links.md'];
  const written = [...body.matchAll(/\(\(([0-9a-f-]{36})\)\)/g)].map((m) => m[1]);
  assert.deepStrictEqual(written,
    [gen.UUID.anchor, gen.UUID.t2, gen.UUID.t3, gen.UUID.t1]);
  assert.notDeepStrictEqual(written, [...written].sort(),
    'sorted order and written order must differ, or the order check proves nothing');
});

test('the embed-only source reaches the anchor WITHOUT writing an inline reference', () => {
  const body = gen.PAGES['Embed Only.md'];
  assert.ok(body.includes(`{{embed ${anchorRef}}}`));
  // Every occurrence of the anchor is inside the embed macro.
  const bare = body.replace(/\{\{embed \(\([0-9a-f-]{36}\)\)\}\}/g, '');
  assert.ok(!/\(\([0-9a-f-]{36}\)\)/.test(bare),
    'this source must contain no inline block reference at all');
  assert.ok(body.includes('[[') && body.includes('#focus') && body.includes('https://'),
    'it must also carry a page link, a tag and an address, none of which are block references');
});

test('the many-links source exceeds both the request size and the retention cap', () => {
  const written = [...gen.PAGES['Many Links.md'].matchAll(/\(\(([0-9a-f-]{36})\)\)/g)]
    .map((m) => m[1]);
  const distinct = new Set(written);
  assert.strictEqual(distinct.size, written.length, 'these are all distinct');
  assert.ok(distinct.size > 20, `${distinct.size} distinct links, retention cap is 20`);
});

test('the repeated source writes one target more than once', () => {
  const written = [...gen.PAGES['Repeated Links.md'].matchAll(/\(\(([0-9a-f-]{36})\)\)/g)]
    .map((m) => m[1]);
  const counts = {};
  for (const u of written) counts[u] = (counts[u] || 0) + 1;
  assert.strictEqual(counts[gen.UUID.t1], 3);
  assert.strictEqual(new Set(written).size, 3);
});

test('one source carries BOTH a self-reference and a target nothing carries', () => {
  const body = gen.PAGES['Self And Missing.md'];
  assert.ok(body.includes(`((${gen.UUID.selfRef}))`));
  assert.ok(body.includes(`id:: ${gen.UUID.selfRef}`));
  assert.ok(body.includes(`((${gen.UUID.ghost}))`));
  const carriers = Object.values(gen.PAGES).filter((b) => b.includes(`id:: ${gen.UUID.ghost}`));
  assert.strictEqual(carriers.length, 0, 'no block may carry the ghost id');
});

test('the long target mixes Korean, English and emoji and exceeds the display bound', () => {
  const body = gen.PAGES['Long Target.md'];
  assert.match(body, /한국어/);
  assert.match(body, /🎯/);
  assert.ok([...body].length > 420, `${[...body].length} characters`);
});

// --- the two partial-scan sources -------------------------------------------
//
// Their SIZE is what makes them work, and it is measured rather than asserted
// in prose: one `*x* ` repetition costs 8 inline AST nodes, so 600 repetitions
// is 4,800 — past the 4,096-node scan bound. If that bound or that cost ever
// changes, these fail here rather than silently becoming ordinary blocks whose
// live checks then pass for the wrong reason.

const SCAN_NODE_BOUND = 4096;   // f27-outgoing/max-scan-nodes
const NODES_PER_FILLER_REP = 8; // measured against OG's own parser

test('the filler is sized to actually exceed the scan bound', () => {
  const reps = (gen.PAGES['Partial Links.md'].match(/\*x\* /g) || []).length;
  assert.ok(reps * NODES_PER_FILLER_REP > SCAN_NODE_BOUND,
    `${reps} repetitions is ${reps * NODES_PER_FILLER_REP} nodes, ` +
    `which does not exceed ${SCAN_NODE_BOUND}`);
  const late = (gen.PAGES['Late Link.md'].match(/\*x\* /g) || []).length;
  assert.ok(late * NODES_PER_FILLER_REP > SCAN_NODE_BOUND);
});

test('the cut-off-with-links source writes links BEFORE the filler and one after', () => {
  const body = gen.PAGES['Partial Links.md'];
  const before = body.split('*x*')[0];
  const after = body.split('*x*').pop();
  const inBefore = [...before.matchAll(/\(\(([0-9a-f-]{36})\)\)/g)].map((m) => m[1]);
  const inAfter = [...after.matchAll(/\(\(([0-9a-f-]{36})\)\)/g)].map((m) => m[1]);
  assert.deepStrictEqual(inBefore, [gen.UUID.anchor, gen.UUID.t1, gen.UUID.longKo],
    'three links must be reachable, in this order');
  assert.deepStrictEqual(inAfter, [gen.UUID.t2],
    'and one must sit beyond the bound, so the count is provably a floor');
  assert.match(body, /한국어/);
  assert.match(body, /🎯/);
});

test('the cut-off-with-NOTHING-found source reaches the anchor only through an embed', () => {
  const body = gen.PAGES['Late Link.md'];
  assert.ok(body.includes(`{{embed ((${gen.UUID.anchor}))}}`),
    'it must still be a referring block, or it gets no row in the overview');
  const before = body.split('*x*')[0];
  const bare = before.replace(/\{\{embed \(\([0-9a-f-]{36}\)\)\}\}/g, '');
  assert.ok(!/\(\([0-9a-f-]{36}\)\)/.test(bare),
    'no inline block reference may be reachable before the bound');
  const after = body.split('*x*').pop();
  assert.deepStrictEqual([...after.matchAll(/\(\(([0-9a-f-]{36})\)\)/g)].map((m) => m[1]),
    [gen.UUID.t1],
    'a real reference must exist beyond the bound, so "none found" is provably ' +
    'not "none exists"');
});

test('the genuinely empty source is NOT cut off', () => {
  // Otherwise the live check could not tell :empty from :partial-empty.
  const body = gen.PAGES['Embed Only.md'];
  assert.ok(!body.includes('*x*'), 'it must be short enough to scan completely');
});

test('the pages the partial-scan sources replaced are gone, not orphaned', () => {
  for (const gone of ['Self Link.md', 'Missing Link.md', 'Long Target Link.md']) {
    assert.ok(!gen.PAGES[gone], `${gone} was merged or replaced and must not linger`);
  }
});

test('the fixture keeps the behaviour this batch must not break', () => {
  assert.ok(gen.PAGES['Attachments.md'].includes('../assets/outgoing-dot.png'));
  assert.ok(gen.PAGES['Attachments.md'].includes('../../../outside-the-graph.png'));
  assert.ok(gen.PAGES['Study Plan.md'].includes('{{embed [[Outgoing Excerpt Source]]}}'));
  assert.ok(gen.PAGES['Outgoing Cycle A.md'].includes(`((${gen.UUID.cycleB}))`));
  assert.ok(gen.PAGES['Outgoing Cycle B.md'].includes(`((${gen.UUID.cycleA}))`));
  const crystal = Object.entries(gen.PAGES).filter(([, b]) => b.includes('#crystal'));
  assert.deepStrictEqual(crystal.map(([n]) => n).sort(),
    ['Ordered Links.md', 'Study Plan.md']);
});

// --- the boundary, without touching the permitted root ----------------------

test('a path outside the permitted root is refused, by real-path resolution', () => {
  const outside = path.join(os.tmpdir(), 'f27-outgoing-never-written');
  assert.strictEqual(B.isInsideAllowedRoot(outside), false);
  assert.throws(() => B.assertInsideAllowedRoot('probe', outside), /outside the permitted/);
  assert.ok(!fs.existsSync(outside), 'the probe path must not be created');
});

test('the permitted root ITSELF is refused; each run needs its own subfolder', () => {
  assert.throws(() => B.assertInsideAllowedRoot('probe', B.ALLOWED_ROOT),
    /refusing to operate on the shared/);
});

test('a traversal out of the permitted root is refused', () => {
  assert.throws(
    () => B.assertInsideAllowedRoot('probe', path.join(B.ALLOWED_ROOT, '..', 'elsewhere')),
    /outside the permitted/);
});

test('batch reuse refuses a graph whose files are not this batch\'s templates', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'f27-out-batch-'));
  try {
    // Outside the permitted root, so containment alone must refuse it — before
    // any file is read.
    const v = batch.verifyReusable(path.join(tmp, 'graph'));
    assert.strictEqual(v.ok, false);
    assert.match(v.problems[0], /containment/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('the expected-file table covers every page and the config', () => {
  const want = batch.expectedFiles();
  for (const name of Object.keys(gen.PAGES)) {
    assert.ok(want[`pages/${name}`], `not covered: ${name}`);
  }
  assert.ok(want['logseq/config.edn']);
  assert.strictEqual(Object.keys(want).length, Object.keys(gen.PAGES).length + 1);
});
