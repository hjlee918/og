'use strict';
//
// The F28 fixture's own rules, checked WITHOUT touching the permitted
// graph-data root.
//
// Nothing here creates, reads or enumerates a graph. It exercises the templates
// and the containment refusals against paths that are never written to. The
// generator's real `build()` is deliberately NOT called: creating a graph is
// what a packaged run does, once, inside the permitted root.
//
// WHY THESE TESTS EXIST AT ALL.
//
// The scenarios that run against this fixture assert things like "OG shows 3
// levels and elides 4". That claim is only worth anything if the fixture really
// contains a path of exactly seven ancestors. A fixture whose shape drifted
// would let a scenario pass while measuring something else — which is precisely
// what happened to the F27 refresh batch, whose fixture had no second level to
// walk and whose checks therefore could not fail. So the DEPTH TABLE the
// scenarios read is checked here against the markdown the fixture actually
// writes, by counting indentation.
//
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const gen = require(path.join(REPO, 'f28-refpath', 'checks', 'make-refpath-graph.js'));
const B = require(path.join(REPO, 'f27-pilot', 'checks', 'allowed-root.js'));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const anchorLink = `[[${gen.ANCHOR}]]`;

/**
 * Every block in one markdown body, with the depth its indentation gives it.
 *
 * Logseq's markdown nests with tabs, one per level, so a block written with `n`
 * tabs has `n` BLOCK ancestors — which is exactly the number OG's breadcrumb is
 * counting when it decides whether to elide. Property lines (`id::`) carry the
 * same tabs plus two spaces and are attached to the block above them.
 */
function blocks(body) {
  const out = [];
  for (const line of body.split('\n')) {
    const m = line.match(/^(\t*)- (.*)$/);
    if (m) { out.push({ depth: m[1].length, text: m[2], props: [] }); continue; }
    const p = line.match(/^(\t*)  (\S.*)$/);
    if (p && out.length) out[out.length - 1].props.push(p[2]);
  }
  return out;
}

/** All blocks across every page and the journal, with the file they came from. */
function allBlocks() {
  const out = [];
  for (const [file, body] of Object.entries(gen.PAGES)) {
    for (const b of blocks(body)) out.push(Object.assign({ file }, b));
  }
  for (const b of blocks(gen.journalBody())) out.push(Object.assign({ file: 'journal' }, b));
  return out;
}

/** The one block carrying `id:: <uuid>`. */
function byId(uuid) {
  return allBlocks().find((b) => b.props.some((p) => p === `id:: ${uuid}`));
}

// --- identities -------------------------------------------------------------

test('every identity the fixture writes is a well-formed, distinct uuid', () => {
  for (const [name, u] of Object.entries(gen.UUID)) {
    assert.match(u, UUID_RE, `${name} is not a uuid`);
  }
  assert.strictEqual(new Set(Object.values(gen.UUID)).size,
    Object.keys(gen.UUID).length, 'identities collide');
});

test('every declared identity is actually written by some page', () => {
  for (const [name, u] of Object.entries(gen.UUID)) {
    assert.ok(byId(u), `${name} (${u}) is declared but no block carries it`);
  }
});

// --- the depth table, which every scenario reads ----------------------------

test('the DEPTH table matches the indentation the fixture actually writes', () => {
  for (const [key, want] of Object.entries(gen.DEPTH)) {
    const uuid = gen.UUID[key];
    assert.ok(uuid, `DEPTH names ${key}, which has no identity`);
    const b = byId(uuid);
    assert.ok(b, `${key} is in DEPTH but nothing carries its id`);
    assert.strictEqual(b.depth, want.depth,
      `${key}: written at depth ${b.depth}, DEPTH says ${want.depth}`);
  }
});

test("the DEPTH table's visible/hidden split is OG's own arithmetic", () => {
  // `breadcrumb` shows at most `:level-limit` (3) and elides the rest. Derived
  // here rather than restated, so a fixture change that moved a boundary cannot
  // agree with a hand-written expectation.
  const LEVEL_LIMIT = 3;
  for (const [key, want] of Object.entries(gen.DEPTH)) {
    assert.strictEqual(want.visible, Math.min(want.depth, LEVEL_LIMIT), key);
    assert.strictEqual(want.hidden, Math.max(0, want.depth - LEVEL_LIMIT), key);
  }
});

test('the fixture covers both sides of the elision boundary, and the boundary itself', () => {
  const depths = Object.values(gen.DEPTH).map((d) => d.depth);
  for (const n of [0, 2, 3, 4]) {
    assert.ok(depths.includes(n), `no reference is written at depth ${n}`);
  }
  assert.ok(Math.max(...depths) >= 6, 'nothing is deep enough to hide several levels');
  const elided = Object.values(gen.DEPTH).filter((d) => d.hidden > 0);
  const shown = Object.values(gen.DEPTH).filter((d) => d.hidden === 0);
  assert.ok(elided.length >= 5 && shown.length >= 3,
    'both outcomes must be represented, or one of them is never observed');
  assert.ok(elided.some((d) => d.hidden === 1),
    'exactly one hidden level is the case a wrong count cannot pass by accident');
});

test('the PATHS table is the complete ancestry each reference really has', () => {
  const all = allBlocks();
  for (const [key, want] of Object.entries(gen.PATHS)) {
    const uuid = gen.UUID[key];
    const idx = all.findIndex((b) => b.props.some((p) => p === `id:: ${uuid}`));
    assert.ok(idx >= 0, key);
    // Walk backwards for the nearest block at each shallower depth, which is
    // what `:block/parent` resolves to.
    const chain = [];
    let want_depth = all[idx].depth - 1;
    for (let i = idx - 1; i >= 0 && want_depth >= 0; i--) {
      if (all[i].file !== all[idx].file) break;
      if (all[i].depth === want_depth) { chain.unshift(all[i].text); want_depth -= 1; }
    }
    assert.deepStrictEqual(chain, want, `${key}: PATHS does not match the outline`);
    assert.strictEqual(chain.length, gen.DEPTH[key].depth, key);
  }
});

// --- the shapes the observations depend on ----------------------------------

test('two references share ONE parent, so one breadcrumb group holds two blocks', () => {
  const a = byId(gen.UUID.deepA);
  const b = byId(gen.UUID.deepB);
  assert.strictEqual(a.depth, b.depth);
  assert.deepStrictEqual(gen.PATHS.deepA, gen.PATHS.deepB,
    'they must have the same ancestry, or they are not one group');
  assert.notStrictEqual(a.text, b.text, 'and be distinguishable on screen');
});

test('two branches SHARE their upper levels and differ only near the reference', () => {
  const deep = gen.PATHS.deepA;
  const branch = gen.PATHS.branch;
  const shared = [];
  for (let i = 0; i < Math.min(deep.length, branch.length); i++) {
    if (deep[i] === branch[i]) shared.push(deep[i]); else break;
  }
  assert.strictEqual(shared.length, 5, `they share ${shared.length} levels, expected 5`);
  assert.notStrictEqual(deep[5], branch[5], 'and must diverge after them');
  // The asymmetry the baseline observed: the deeper one hides a level the
  // shallower one shows.
  assert.ok(gen.DEPTH.deepA.hidden > gen.DEPTH.branch.hidden);
});

test('one path has ancestors that all carry the SAME text', () => {
  const p = gen.PATHS.same;
  assert.strictEqual(new Set(p).size, 1, 'they must be identical');
  assert.strictEqual(p.length, gen.SAME_CHAIN.length);
  assert.ok(p[0].trim().length > 0);
});

test('the identical ancestors run PAST the limit, and each has its own identity', () => {
  // A chain of four left only ONE identical row disclosed, which cannot show
  // that a step travels on its identity rather than on its label: one row is
  // never ambiguous. Six leaves three identical rows in the panel, so choosing
  // the wrong one is a mistake the run can actually catch.
  const want = gen.DEPTH.same;
  assert.strictEqual(gen.SAME_CHAIN.length, want.depth);
  assert.ok(want.hidden >= 3,
    `only ${want.hidden} identical row(s) are disclosed; at least three are needed`);

  const ids = gen.SAME_CHAIN.map((k) => {
    const u = gen.UUID[k];
    assert.ok(u, `${k} has no identity`);
    return u;
  });
  assert.strictEqual(new Set(ids).size, ids.length, 'the identical rows share an identity');

  // Written outermost-first, one level apart, all reading the same words.
  gen.SAME_CHAIN.forEach((k, i) => {
    const b = byId(gen.UUID[k]);
    assert.ok(b, `${k} is declared but nothing carries it`);
    assert.strictEqual(b.depth, i, `${k} is written at depth ${b.depth}, expected ${i}`);
    assert.strictEqual(b.text, gen.TEXT.sameName, `${k} does not carry the shared text`);
  });

  // And the reference itself hangs off the innermost of them.
  assert.strictEqual(byId(gen.UUID.same).depth, gen.SAME_CHAIN.length);
});

test('the sources are four different pages, one of them a journal', () => {
  const files = new Set();
  for (const key of Object.keys(gen.DEPTH)) {
    const uuid = gen.UUID[key];
    files.add(byId(uuid).file);
  }
  assert.strictEqual(files.size, 4, [...files].join(', '));
  assert.ok(files.has('journal'), 'a journal must be one of the sources');
  assert.ok([...files].some((f) => f.includes('Deep Source')));
  assert.ok([...files].some((f) => f.includes('Other Source')));
});

test('exactly eleven blocks link the anchor, and the DEPTH table names all of them', () => {
  const linking = allBlocks().filter((b) => b.text.includes(anchorLink));
  assert.strictEqual(linking.length, 11, linking.map((b) => b.text.slice(0, 30)).join(' | '));
  assert.strictEqual(Object.keys(gen.DEPTH).length, 11);
  for (const key of Object.keys(gen.DEPTH)) {
    const b = byId(gen.UUID[key]);
    assert.ok(b.text.includes(anchorLink), `${key} does not link the anchor`);
  }
});

test('no ANCESTOR links the anchor, so every listed block is a leaf of its path', () => {
  // An ancestor that also linked the anchor would appear in the list on its own
  // and change the grouping the scenarios count.
  const ancestorTexts = new Set(Object.values(gen.PATHS).flat());
  for (const t of ancestorTexts) {
    assert.ok(!t.includes(anchorLink), `an ancestor links the anchor: ${t}`);
  }
});

test('one ancestor carries a PAGE LINK, which is what the filter matches on', () => {
  const withLink = Object.values(gen.PATHS).flat()
    .filter((t) => t.includes(`[[${gen.FILTER_TAG}]]`));
  assert.ok(withLink.length > 0, 'no ancestor carries the filter tag');
  assert.strictEqual(new Set(withLink).size, 1, 'exactly one distinct ancestor carries it');
  // It must sit ABOVE what OG shows for at least one reference, so filtering
  // and the disclosure are about the same, otherwise-invisible part of a path.
  const deep = gen.PATHS.deepA;
  const at = deep.findIndex((t) => t.includes(`[[${gen.FILTER_TAG}]]`));
  assert.ok(at >= 0 && at < deep.length - 3,
    'the tagged ancestor must be one OG elides for the deepest reference');
});

test('Korean and English appear throughout, and emoji survive in the leaves', () => {
  const hangul = /[가-힯]/;
  for (const key of Object.keys(gen.DEPTH)) {
    assert.match(byId(gen.UUID[key]).text, hangul, `${key} has no Korean`);
  }
  const paths = Object.values(gen.PATHS).flat();
  assert.ok(paths.some((t) => hangul.test(t)), 'no ancestor is Korean');
  assert.ok(paths.some((t) => /[A-Za-z]/.test(t)), 'no ancestor is English');
  const emoji = ['🎯', '🌿', '🔗', '♻️', '📅'];
  const leaves = Object.keys(gen.DEPTH).map((k) => byId(gen.UUID[k]).text).join(' ');
  for (const e of emoji) assert.ok(leaves.includes(e), `${e} is not in the fixture`);
});

test('the control page is written, is named, and nothing references it', () => {
  assert.ok(gen.PAGES['F28 Control.md'], 'the control page is missing');
  assert.strictEqual(gen.CONTROL_FILE, 'pages/F28 Control.md');
  assert.ok(!gen.PAGES['F28 Control.md'].includes(anchorLink));
  for (const [file, body] of Object.entries(gen.PAGES)) {
    if (file === 'F28 Control.md') continue;
    assert.ok(!body.includes('[[F28 Control]]'), `${file} links the control page`);
  }
});

test('the journal is dated today, so OG files it as a journal rather than a page', () => {
  const d = new Date(2026, 8, 8);
  assert.strictEqual(gen.journalName(d), '2026_09_08.md');
  assert.match(gen.journalName(), /^\d{4}_\d{2}_\d{2}\.md$/);
});

test('one path is deeper than a single batch, so continuation is exercised', () => {
  const d = gen.DEPTH.deepest;
  const first = gen.DEEPEST_PRESSES[0];
  const last = gen.DEEPEST_PRESSES[gen.DEEPEST_PRESSES.length - 1];
  // og-visible-levels (3) + batch (8) = 11 loaded on the first press, of which
  // 3 are already on the row. Derived from the fixture's own depth rather than
  // restated, so a deeper or shallower chain fails here.
  assert.strictEqual(first.shows, 11 - 3);
  assert.ok(d.depth > 11, `depth ${d.depth} would complete in one press`);
  assert.strictEqual(first.complete, false);
  assert.strictEqual(first.continues, true);
  assert.strictEqual(last.complete, true);
  assert.strictEqual(last.continues, false);
  assert.strictEqual(last.shows, d.hidden);
  assert.strictEqual(gen.DEEPEST_LEVELS.length, d.depth);
});

test('an ELIDED ancestor carries an image link and a macro, so a step can be proved plain', () => {
  const withMarkup = gen.DEEPEST_LEVELS.filter((t) => t.includes('!['));
  assert.strictEqual(withMarkup.length, 1);
  assert.ok(withMarkup[0].includes('{{query'), 'and a macro');
  const at = gen.DEEPEST_LEVELS.indexOf(withMarkup[0]);
  assert.ok(at < gen.DEEPEST_LEVELS.length - 3,
    'it must be a level OG elides, or it is never inside the panel at all');
  assert.ok(at >= gen.DEPTH.deepest.depth - 11,
    'and one the FIRST press reaches, so no second press is needed to see it');
});

test('every level of the deepest chain is distinct, so order is observable', () => {
  assert.strictEqual(new Set(gen.DEEPEST_LEVELS).size, gen.DEEPEST_LEVELS.length);
  assert.ok(gen.DEEPEST_LEVELS.every((t) => /[가-힯]/.test(t)));
});

test('the config asks for journals and names the anchor as the default page', () => {
  assert.match(gen.CONFIG, /:feature\/enable-journals\? true/);
  assert.ok(gen.CONFIG.includes(`:default-home {:page "${gen.ANCHOR}"}`));
  assert.match(gen.CONFIG, /:preferred-format "Markdown"/);
});

// --- the boundary, without touching the permitted root ----------------------

test('a path outside the permitted root is refused, by real-path resolution', () => {
  const outside = path.join(os.tmpdir(), 'f28-refpath-never-written');
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

test('the generator refuses to reuse a name that already exists', () => {
  // Read out of the source rather than exercised, because exercising it would
  // mean creating a graph inside the permitted root from a unit test.
  const src = fs.readFileSync(
    path.join(REPO, 'f28-refpath', 'checks', 'make-refpath-graph.js'), 'utf8');
  assert.match(src, /refusing to reuse another run/);
  assert.match(src, /mkdirSync\(graph, \{ recursive: false \}\)/);
  assert.ok(!/rmSync|unlinkSync|rmdirSync/.test(src),
    'the fixture generator must never delete anything');
});

test('the generator names each run uniquely, and only inside the permitted root', () => {
  const src = fs.readFileSync(
    path.join(REPO, 'f28-refpath', 'checks', 'make-refpath-graph.js'), 'utf8');
  assert.match(src, /f28-refpath-\$\{opts\.kind \|\| 'run'\}-\$\{stamp\}/);
  assert.match(src, /B\.assertInsideAllowedRoot\('refpath graph'/);
  for (const label of ['graph subdir', 'graph config', 'graph page', 'graph journal']) {
    assert.ok(src.includes(`assertInsideAllowedRoot('${label}'`),
      `${label} is written without proving containment`);
  }
});
