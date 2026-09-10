'use strict';
//
// The F28 CHILD-CONTEXT fixture's own rules, checked WITHOUT touching the
// permitted graph-data root.
//
// Nothing here creates, reads or enumerates a graph. It exercises the templates
// and the containment refusals against paths that are never written to. The
// generator's real `build()` is deliberately NOT called: creating a graph is
// what a packaged run does, once, inside the permitted root.
//
// WHY THESE TESTS EXIST AT ALL.
//
// The scenarios that run against this fixture assert things like "this row has
// four children in the outline and OG's list attaches exactly one of them".
// That claim is only worth anything if the fixture really writes four children
// and really has exactly one of them naming the page. A fixture whose shape
// drifted would let a scenario pass while measuring something else. So the
// CHILDREN table and the DEPTH table the scenarios read are both checked here
// against the markdown the fixture actually writes, by counting indentation and
// by counting page links.
//
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const gen = require(path.join(REPO, 'f28-refpath', 'checks', 'make-refctx-graph.js'));
const B = require(path.join(REPO, 'f27-pilot', 'checks', 'allowed-root.js'));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const anchorLink = `[[${gen.ANCHOR}]]`;

/**
 * Every block in one markdown body, with the depth its indentation gives it.
 *
 * Logseq's markdown nests with tabs, one per level, so a block written with `n`
 * tabs has `n` BLOCK ancestors. Property lines (`id::`) carry the same tabs
 * plus two spaces and are attached to the block above them.
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

/** All blocks across every page and the journal, in file order. */
function allBlocks() {
  const out = [];
  for (const [file, body] of Object.entries(gen.PAGES)) {
    for (const b of blocks(body)) out.push(Object.assign({ file }, b));
  }
  for (const b of blocks(gen.journalBody())) out.push(Object.assign({ file: 'journal' }, b));
  return out;
}

/** One file's blocks, so sibling/child relationships stay within their file. */
function fileBlocks(uuid) {
  for (const [file, body] of Object.entries(gen.PAGES)) {
    const bs = blocks(body);
    if (bs.some((b) => b.props.includes(`id:: ${uuid}`))) return { file, bs };
  }
  const jb = blocks(gen.journalBody());
  if (jb.some((b) => b.props.includes(`id:: ${uuid}`))) return { file: 'journal', bs: jb };
  return null;
}

function indexOfId(bs, uuid) {
  return bs.findIndex((b) => b.props.includes(`id:: ${uuid}`));
}

/**
 * The IMMEDIATE children of one block, read out of the indentation: every
 * following block at depth+1, stopping at the first block that returns to the
 * block's own depth or shallower.
 */
function immediateChildren(uuid) {
  const found = fileBlocks(uuid);
  if (!found) return null;
  const { bs } = found;
  const i = indexOfId(bs, uuid);
  const d = bs[i].depth;
  const kids = [];
  for (let j = i + 1; j < bs.length; j++) {
    if (bs[j].depth <= d) break;
    if (bs[j].depth === d + 1) kids.push(bs[j]);
  }
  return kids;
}

/** Every descendant of one block, at any depth. */
function descendants(uuid) {
  const found = fileBlocks(uuid);
  if (!found) return null;
  const { bs } = found;
  const i = indexOfId(bs, uuid);
  const d = bs[i].depth;
  const out = [];
  for (let j = i + 1; j < bs.length; j++) {
    if (bs[j].depth <= d) break;
    out.push(bs[j]);
  }
  return out;
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
  const all = allBlocks();
  for (const [name, u] of Object.entries(gen.UUID)) {
    assert.ok(all.some((b) => b.props.includes(`id:: ${u}`)),
      `${name} (${u}) is declared but never written`);
  }
});

test("this fixture's identities cannot be confused with the source-path fixture's", () => {
  const refpath = require(path.join(REPO, 'f28-refpath', 'checks', 'make-refpath-graph.js'));
  const mine = new Set(Object.values(gen.UUID));
  for (const u of Object.values(refpath.UUID)) {
    assert.ok(!mine.has(u), `${u} belongs to both fixtures`);
  }
});

// --- the CHILDREN table, against the markdown that is actually written -------

test('every case declares as many immediate children as the outline writes', () => {
  for (const [key, want] of Object.entries(gen.CHILDREN)) {
    const kids = immediateChildren(gen.UUID[key]);
    assert.ok(kids, `${key}: not found in any page`);
    assert.strictEqual(kids.length, want.own,
      `${key}: declared ${want.own} children, the outline writes ${kids.length}`);
  }
});

test('every case declares as many total descendants as the outline writes', () => {
  for (const [key, want] of Object.entries(gen.CHILDREN)) {
    const d = descendants(gen.UUID[key]);
    assert.strictEqual(d.length, want.descend,
      `${key}: declared ${want.descend} descendants, the outline writes ${d.length}`);
  }
});

test('`namesPage` is exactly the number of immediate children that name the page', () => {
  // OG's list is selected on `:block/path-refs` (inherited from every ancestor)
  // and COUNTED on `:block/refs` (direct mentions only). A child that names the
  // page is therefore both a result in its own right and context under its
  // parent, and a child that does not is only the second. Declaring the number
  // and deriving it from the same markdown is what makes that distinction
  // checkable rather than a reading of the source.
  for (const [key, want] of Object.entries(gen.CHILDREN)) {
    const kids = immediateChildren(gen.UUID[key]);
    const naming = kids.filter((k) => k.text.includes(anchorLink)).length;
    assert.strictEqual(naming, want.namesPage,
      `${key}: declared ${want.namesPage} children naming the page, ${naming} do`);
  }
});

test('every case declares the depth of its own deepest descendant', () => {
  for (const [key, want] of Object.entries(gen.CHILDREN)) {
    const found = fileBlocks(gen.UUID[key]);
    const base = found.bs[indexOfId(found.bs, gen.UUID[key])].depth;
    const d = descendants(gen.UUID[key]);
    const deepest = d.length ? Math.max(...d.map((b) => b.depth)) - base : 0;
    assert.strictEqual(deepest, want.maxDepth,
      `${key}: declared maxDepth ${want.maxDepth}, the outline writes ${deepest}`);
  }
});

test('the leaf case really has nothing written under it', () => {
  assert.strictEqual(immediateChildren(gen.UUID.leaf).length, 0);
  assert.strictEqual(descendants(gen.UUID.leaf).length, 0);
});

test('the mixed case is the only one whose children are part reference, part context', () => {
  const split = Object.entries(gen.CHILDREN)
    .filter(([, v]) => v.namesPage > 0 && v.namesPage < v.own)
    .map(([k]) => k);
  assert.deepStrictEqual(split, ['mixed'],
    'exactly one case must be able to tell a counted reference from plain context');
});

test('KIDS lists the immediate children in the order the outline writes them', () => {
  for (const [key, want] of Object.entries(gen.KIDS)) {
    const kids = immediateChildren(gen.UUID[key]).map((k) => k.text);
    assert.deepStrictEqual(kids, want, `${key}: KIDS is out of step with the outline`);
  }
});

// --- the DEPTH table (the parent context this batch must not disturb) --------

test('every case declares as many ancestors as its indentation gives it', () => {
  for (const [key, want] of Object.entries(gen.DEPTH)) {
    const found = fileBlocks(gen.UUID[key]);
    const i = indexOfId(found.bs, gen.UUID[key]);
    assert.strictEqual(found.bs[i].depth, want.depth,
      `${key}: declared ${want.depth} ancestors, indented ${found.bs[i].depth}`);
    assert.strictEqual(want.visible + want.hidden, want.depth,
      `${key}: visible + hidden must be the depth`);
  }
});

test('no case in this fixture is deep enough for OG to elide its path', () => {
  // Deliberate: this batch is about what is written UNDER a reference. A `⋯` in
  // a breadcrumb would drag the source-path control into every observation and
  // make "nothing about the parent context changed" harder to read, not easier.
  for (const [key, want] of Object.entries(gen.DEPTH)) {
    assert.strictEqual(want.hidden, 0, `${key} would elide ${want.hidden} ancestors`);
    assert.ok(want.depth <= 3, `${key} is ${want.depth} deep; OG shows only 3`);
  }
});

// --- the bounded cases ------------------------------------------------------

test('the wide case is wide at ONE level, so OG shows all of it', () => {
  assert.strictEqual(gen.WIDE_CHILDREN.length, 14);
  assert.strictEqual(new Set(gen.WIDE_CHILDREN).size, 14, 'wide children must be distinguishable');
  assert.strictEqual(gen.CHILDREN.wide.behind, 0,
    'the wide case must gain nothing: it is entirely inside the two levels OG draws');
});

test('the batch case really is wider than one bounded batch', () => {
  assert.strictEqual(gen.BATCH_CHILDREN.length, 12);
  assert.strictEqual(new Set(gen.BATCH_CHILDREN).size, 12, 'they must be distinguishable');
  // f27-children/default-batch is 10 and its continuation adds another 10.
  assert.ok(gen.BATCH_CHILDREN.length > 10, 'nothing would be withheld');
  assert.ok(gen.BATCH_CHILDREN.length <= 20, 'one continuation must be enough');
});

test('the batch press table adds up to the blocks behind the collapsed row', () => {
  const last = gen.BATCH_PRESSES[gen.BATCH_PRESSES.length - 1];
  assert.strictEqual(last.shows, gen.BATCH_CHILDREN.length);
  assert.strictEqual(last.remaining, 0);
  assert.strictEqual(last.continues, false);
  for (const p of gen.BATCH_PRESSES) {
    assert.strictEqual(p.shows + p.remaining, gen.BATCH_CHILDREN.length,
      `press ${p.press}: shown + remaining must be every block`);
  }
});

// --- the wall: the rows OG collapses, and what is behind each of them -------

test('every WALL row really sits at the second level of its reference\'s subtree', () => {
  // `non-consecutive-blocks->vec-tree` numbers a reference's own subtree from
  // 1, so the row OG collapses is the one whose OUTLINE depth is two below the
  // referencing block's.
  for (const [key, want] of Object.entries(gen.WALL)) {
    const row = fileBlocks(gen.UUID[key]);
    assert.ok(row, `${key}: not found in any page`);
    const ref = fileBlocks(gen.UUID[want.under]);
    assert.strictEqual(row.file, ref.file, `${key} is not on ${want.under}'s page`);
    const rowDepth = row.bs[indexOfId(row.bs, gen.UUID[key])].depth;
    const refDepth = ref.bs[indexOfId(ref.bs, gen.UUID[want.under])].depth;
    assert.strictEqual(rowDepth - refDepth, 2,
      `${key} is ${rowDepth - refDepth} level(s) below ${want.under}; OG collapses the second`);
  }
});

test('every WALL row has children, which is the other half of what collapses it', () => {
  for (const key of Object.keys(gen.WALL)) {
    assert.ok(immediateChildren(gen.UUID[key]).length > 0,
      `${key} has no children, so OG would not collapse it`);
  }
});

test('each WALL row declares exactly what the outline writes behind it', () => {
  for (const [key, want] of Object.entries(gen.WALL)) {
    const d = descendants(gen.UUID[key]);
    assert.strictEqual(d.length, want.hidden,
      `${key}: declared ${want.hidden} blocks behind it, the outline writes ${d.length}`);
    const base = fileBlocks(gen.UUID[key]).bs[
      indexOfId(fileBlocks(gen.UUID[key]).bs, gen.UUID[key])].depth;
    const levels = d.length ? Math.max(...d.map((b) => b.depth)) - base : 0;
    assert.strictEqual(levels, want.levels,
      `${key}: declared ${want.levels} level(s) behind it, the outline writes ${levels}`);
  }
});

test('`ogShows` + `behind` is every descendant, for every case', () => {
  for (const [key, want] of Object.entries(gen.CHILDREN)) {
    assert.strictEqual(want.ogShows + want.behind, want.descend,
      `${key}: ogShows + behind must be descend`);
  }
});

test('`behind` on a case is exactly the sum of the rows collapsed underneath it', () => {
  const sums = {};
  for (const want of Object.values(gen.WALL)) {
    sums[want.under] = (sums[want.under] || 0) + want.hidden;
  }
  // `TWICE` is collapsed by the FILE rather than by the level rule, so it is
  // not in WALL — but what it withholds is just as absent from the page, both
  // under its parent and under itself.
  sums[gen.TWICE.under] = (sums[gen.TWICE.under] || 0) + gen.TWICE.hidden;
  sums[gen.TWICE.key] = (sums[gen.TWICE.key] || 0) + gen.TWICE.hidden;
  for (const [key, want] of Object.entries(gen.CHILDREN)) {
    assert.strictEqual(want.behind, sums[key] || 0,
      `${key}: declared behind ${want.behind}, the collapsed rows account for ${sums[key] || 0}`);
  }
});

// --- the same block, twice, in one list -------------------------------------

test('TWICE really names a block that OG draws twice in one list', () => {
  const k = gen.TWICE.key;
  // It names the page itself, so it is a result in its own right...
  const own = fileBlocks(gen.UUID[k]);
  assert.ok(own, `${k}: not found in any page`);
  const text = gen.TEXT[k];
  assert.ok(text.includes(`[[${gen.ANCHOR}]]`),
    `${k} must name the anchor page to be a result of its own`);
  // ...and it is a descendant of another block that also names the page, so
  // OG attaches it a second time as that block's context.
  const parentText = gen.TEXT[gen.TWICE.under];
  assert.ok(parentText.includes(`[[${gen.ANCHOR}]]`),
    `${gen.TWICE.under} must also name the page, or there is only one appearance`);
  const parent = fileBlocks(gen.UUID[gen.TWICE.under]);
  assert.strictEqual(own.file, parent.file, 'both must be on one page');
  const kDepth = own.bs[indexOfId(own.bs, gen.UUID[k])].depth;
  const pDepth = parent.bs[indexOfId(parent.bs, gen.UUID[gen.TWICE.under])].depth;
  assert.ok(kDepth > pDepth, `${k} must sit under ${gen.TWICE.under}`);
});

test('TWICE is collapsed by the FILE, so BOTH appearances are eligible', () => {
  // The level rule cannot do this: as its own result it is a root, and under
  // its parent it is a child rather than a grandchild. Only `collapsed:: true`
  // collapses it in both roles, and it must be written on THAT block.
  const k = gen.TWICE.key;
  const page = Object.values(gen.PAGES).find((b) => b.includes(`id:: ${gen.UUID[k]}`));
  assert.ok(page, `${k}: no page carries it`);
  const lines = page.split('\n');
  const at = lines.findIndex((l) => l.includes(`id:: ${gen.UUID[k]}`));
  assert.ok(at > 0);
  assert.ok(lines[at + 1] && lines[at + 1].includes('collapsed:: true'),
    `${k} must carry \`collapsed:: true\` directly under its id`);
  assert.strictEqual(gen.TWICE.collapsedBy, 'file');

  // Exactly one block in the whole fixture is folded this way, so a second one
  // cannot quietly appear and change what the run is counting.
  const folded = Object.values(gen.PAGES)
    .reduce((n, b) => n + (b.match(/collapsed:: true/g) || []).length, 0);
  assert.strictEqual(folded, 1, 'exactly one block may be folded in the file');

  // And it must actually have something to withhold, in both appearances.
  assert.strictEqual(immediateChildren(gen.UUID[k]).length, gen.TWICE.hidden);
  assert.strictEqual(descendants(gen.UUID[k]).length, gen.TWICE.hidden);
});

test('the collapsed-appearance count counts APPEARANCES, not blocks', () => {
  // What a run counts on screen is controls, and one block wearing two
  // appearances offers two of them.
  assert.strictEqual(gen.COLLAPSED_APPEARANCES,
    Object.keys(gen.WALL).length + gen.TWICE.occurrences);
  assert.strictEqual(gen.TWICE.occurrences, 2);
  assert.ok(!Object.keys(gen.WALL).includes(gen.TWICE.key),
    'TWICE is not a WALL row: it is collapsed by the file, not by the level rule');
});

test('some cases are entirely inside what OG draws, and must gain nothing', () => {
  // Pinned as an EXACT set rather than a minimum. `mixed` and `mixedRef` left
  // it when `mixedRef` was folded in the file to make the two-occurrence case
  // (see TWICE), and a threshold would have absorbed that silently in one
  // direction and blocked it in the other. The four that remain still cover
  // the shapes that matter: no children at all, ordinary children, a member of
  // a shared parent group, and a wide fan of fourteen.
  const untouched = Object.entries(gen.CHILDREN)
    .filter(([, v]) => v.behind === 0).map(([k]) => k).sort();
  assert.deepStrictEqual(untouched, ['leaf', 'sibB', 'two', 'wide'],
    'the set of cases OG draws in full changed; say so deliberately');
  for (const k of untouched) {
    assert.strictEqual(gen.CHILDREN[k].ogShows, gen.CHILDREN[k].descend);
  }
  assert.strictEqual(gen.CHILDREN.leaf.descend, 0, 'one case must have nothing under it');
  assert.ok(gen.CHILDREN.wide.descend >= 14, 'one must be wider than a single batch');
});

test('one group holds a reference with a wall and a reference without one', () => {
  // sibA and sibB share a parent, so they share a breadcrumb group. Only A has
  // anything behind the wall, which is what makes leakage between two rows of
  // the same group observable.
  assert.ok(gen.CHILDREN.sibA.behind > 0, 'sibA must have a branch behind the wall');
  assert.strictEqual(gen.CHILDREN.sibB.behind, 0, 'sibB must have none');
  const a = fileBlocks(gen.UUID.sibA);
  const b = fileBlocks(gen.UUID.sibB);
  assert.strictEqual(a.file, b.file, 'they must be on one page');
});

test('the deep case runs several levels past OG\'s default open-blocks level', () => {
  // `state/get-ref-open-blocks-level` is 2 by default, and
  // `f27-children/max-depth` is 5. Six levels passes both.
  assert.strictEqual(gen.DEEP_LEVELS.length, 6);
  const found = fileBlocks(gen.UUID.deep);
  const i = indexOfId(found.bs, gen.UUID.deep);
  const base = found.bs[i].depth;
  const chain = descendants(gen.UUID.deep);
  assert.strictEqual(chain.length, 6);
  chain.forEach((b, n) => {
    assert.strictEqual(b.depth, base + n + 1,
      `deep descendant ${n + 1} must be exactly one level below the one above it`);
  });
});

// --- presentation and safety ------------------------------------------------

test('exactly two blocks carry markup: one OG draws and one behind the wall', () => {
  const withMarkup = allBlocks().filter((b) =>
    /!\[[^\]]*\]\(/.test(b.text) || /\{\{/.test(b.text));
  assert.strictEqual(withMarkup.length, 2,
    'one visible twin and one hidden twin, so the two presentations can be compared');
  const ids = withMarkup.flatMap((b) => b.props.filter((p) => p.startsWith('id:: ')));
  assert.ok(ids.includes(`id:: ${gen.UUID.markup}`), 'the one OG draws');
  assert.ok(ids.includes(`id:: ${gen.UUID.deepD3}`), 'the one behind the wall');
  for (const b of withMarkup) {
    assert.ok(b.text.includes('!['), 'an image link');
    assert.ok(b.text.includes('{{query'), 'a macro');
    assert.ok(b.text.includes(`[[${gen.FILTER_TAG}]]`), 'a page link');
  }
});

test('the hidden markup block really is behind the wall', () => {
  assert.ok(descendants(gen.UUID.deepD2).some((b) =>
    b.props.includes(`id:: ${gen.UUID.deepD3}`)),
    'the markup twin must sit behind the row OG collapses');
});

test('the asset the markup child names is one this generator really writes', () => {
  // OG renders a linked reference's children through its ordinary outline
  // renderer, so an image link in a child is REQUESTED. Naming a file that does
  // not exist made the run report `net::ERR_FILE_NOT_FOUND` — a real window
  // error the conservative classifier correctly refused to excuse. The fixture
  // stops provoking it; no exemption was widened.
  for (const t of [gen.TEXT.markup, gen.DEEP_LEVELS[2]]) {
    const named = t.match(/\(\.\.\/([^)]+\.png)\)/);
    assert.ok(named, 'a markup block must name an image path');
    assert.strictEqual(`assets/${named[1].replace(/^assets\//, '')}`, gen.ASSET_FILE);
  }
  assert.ok(Buffer.isBuffer(gen.ASSET_BYTES) && gen.ASSET_BYTES.length > 0);
  // A real PNG, so nothing downstream has to special-case it.
  assert.strictEqual(gen.ASSET_BYTES.slice(1, 4).toString('latin1'), 'PNG');
});

test('Korean and English are both present, and emoji survive the templates', () => {
  const all = allBlocks().map((b) => b.text).join('\n');
  assert.match(all, /[가-힣]/, 'no Korean');
  assert.match(all, /[A-Za-z]{4,}/, 'no English');
  assert.match(all, /\p{Extended_Pictographic}/u, 'no emoji');
});

test('every referencing block names the page, and nothing else does', () => {
  const naming = allBlocks().filter((b) => b.text.includes(anchorLink));
  const declared = gen.REFERENCING.map((k) => gen.UUID[k]);
  assert.strictEqual(naming.length, declared.length,
    `${naming.length} blocks name the page; ${declared.length} are declared`);
  for (const u of declared) {
    assert.ok(naming.some((b) => b.props.includes(`id:: ${u}`)),
      `${u} is declared as a reference but does not name the page`);
  }
});

test('a journal is one of the sources, and it is not written as a page', () => {
  assert.ok(gen.journalBody().includes(anchorLink), 'the journal must reference the page');
  assert.match(gen.journalName(new Date(2026, 8, 9)), /^2026_09_09\.md$/);
  for (const file of Object.keys(gen.PAGES)) {
    assert.ok(!/^\d{4}_\d{2}_\d{2}\.md$/.test(file), `${file} is a journal in pages/`);
  }
});

test('the control page is named by nothing and links to nothing', () => {
  const body = gen.PAGES['F28 Context Control.md'];
  assert.ok(body, 'the control page must exist');
  assert.ok(!body.includes(anchorLink), 'the control page must not reference the anchor');
  const all = Object.entries(gen.PAGES)
    .filter(([f]) => f !== 'F28 Context Control.md')
    .map(([, b]) => b).concat([gen.journalBody()]).join('\n');
  assert.ok(!all.includes('F28 Context Control'), 'something links to the control page');
  assert.strictEqual(gen.CONTROL_FILE, 'pages/F28 Context Control.md');
});

// --- containment ------------------------------------------------------------

test('build refuses a graph root outside the permitted root', () => {
  // The refusal is exercised WITHOUT creating anything: `allowedRootReal()` is
  // stubbed to a temporary directory that is not the permitted root, and the
  // boundary module must refuse before any mkdir happens.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'f28-refctx-refusal-'));
  const real = B.allowedRootReal;
  try {
    B.allowedRootReal = () => tmp;
    assert.throws(() => gen.build({ kind: 'refusal-probe', stamp: 'never' }),
      (e) => e instanceof B.BoundaryViolation || /allowed root|permitted/i.test(e.message));
    assert.deepStrictEqual(fs.readdirSync(tmp), [], 'the refusal created something');
  } finally {
    B.allowedRootReal = real;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('readPage proves containment again at read time', () => {
  assert.throws(() => gen.readPage('/etc', 'passwd'),
    (e) => e instanceof B.BoundaryViolation || /allowed root|permitted/i.test(e.message));
});
