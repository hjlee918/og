'use strict';
//
// The ORDERING fixture's own rules, and the JS mirror of the ordering rule.
//
// The fixture is what makes a wrong comparison VISIBLE rather than merely
// unproven, so its own properties are asserted here rather than assumed by the
// scenarios that read it:
//
//   * the source-page titles really do discriminate case-folding, Korean
//     alphabetical order and Unicode normalization;
//   * the pages really carry the depth OG needs before it draws the earlier
//     F28 slices' controls at all — without it "the disclosure controls still
//     work after a reorder" would have nothing to be true of;
//   * the JS mirror of the comparison agrees with the specification.
//
// The mirror is used by both scenarios ONLY as a cross-check: each asserts the
// drawn order against a written-down expectation first, and against the mirror
// second, so an error shared by the mirror and the product cannot pass unseen.
//
// Nothing here writes a graph, launches an application or reads one.
//
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const RG = require(path.join(__dirname, '..', 'checks', 'make-reforder-graph.js'));

// --- the titles -------------------------------------------------------------

test('the source-page titles discriminate case folding', () => {
  assert.ok(RG.APPLE === RG.APPLE.toLowerCase(), 'apple source must be lower-case');
  assert.ok(/^[A-Z]/.test(RG.BANANA), 'Banana Source must start with a capital');
  assert.ok(/^[A-Z]/.test(RG.ZEBRA), 'Zebra Source must start with a capital');
  assert.ok(RG.compareTitles(RG.APPLE, RG.BANANA) < 0);
  assert.ok(RG.compareTitles(RG.BANANA, RG.ZEBRA) < 0);
});

test('the Korean titles are one per initial, in ga-na-da order', () => {
  const korean = [RG.GA, RG.NA, RG.DA, RG.HA];
  for (let i = 1; i < korean.length; i++) {
    assert.ok(RG.compareTitles(korean[i - 1], korean[i]) < 0,
      `${korean[i - 1]} must sort before ${korean[i]}`);
  }
  assert.ok(RG.compareTitles(RG.ZEBRA, RG.GA) < 0, 'Latin sorts before Hangul');
});

test('one source page is written to disk with a decomposed name', () => {
  assert.notStrictEqual(RG.HA_FILE_TITLE, RG.HA, 'the NFD form must differ from the NFC form');
  assert.strictEqual(RG.HA_FILE_TITLE.normalize('NFC'), RG.HA);
  assert.ok(RG.PAGES[`${RG.HA_FILE_TITLE}.md`], 'the page must be keyed by the NFD name');
  assert.ok(!RG.PAGES[`${RG.HA}.md`], 'and not also by the NFC name');
});

test('the decomposed title would sort FIRST without the NFC step, and LAST with it', () => {
  const raw = (a, b) => {
    const x = Array.from(a.toLowerCase()).map((c) => c.codePointAt(0));
    const y = Array.from(b.toLowerCase()).map((c) => c.codePointAt(0));
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
      if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    }
    return x.length - y.length;
  };
  assert.ok(raw(RG.HA_FILE_TITLE, RG.GA) < 0,
    'without normalization the decomposed title sorts before 가 — this is the defect');
  assert.ok(RG.compareTitles(RG.HA_FILE_TITLE, RG.GA) > 0,
    'with it, it sorts where its composed form belongs');
});

test('every source page has a distinct sort key, so no tie decides the order', () => {
  const keys = Object.values(RG.GROUP_IDS).map(RG.sortKey);
  assert.strictEqual(new Set(keys).size, keys.length);
});

test('the group identities are OG\'s own page-identity mandate', () => {
  for (const [k, id] of Object.entries(RG.GROUP_IDS)) {
    assert.strictEqual(id, id.normalize('NFC').toLowerCase(), `${k} must be NFC lower-case`);
  }
});

// --- the shape --------------------------------------------------------------

test('every referencing block is on exactly one page and names the anchor or its alias', () => {
  assert.strictEqual(RG.REFERENCING.length, 10);
  const bodies = Object.values(RG.PAGES).join('\n') + RG.journalBody();
  for (const key of RG.REFERENCING) {
    const uuid = RG.UUID[key];
    assert.ok(uuid, `${key} has no identity`);
    const at = bodies.split(uuid).length - 1;
    assert.strictEqual(at, 1, `${key} must appear exactly once in the fixture`);
    const text = RG.TEXT[key];
    assert.ok(text.includes(`[[${RG.ANCHOR}]]`) || text.includes(`[[${RG.ALIAS}]]`),
      `${key} must name the anchor or its alias`);
  }
});

test('exactly one referencing block names the ALIAS rather than the anchor', () => {
  const viaAlias = RG.REFERENCING.filter((k) => RG.TEXT[k].includes(`[[${RG.ALIAS}]]`));
  assert.deepStrictEqual(viaAlias, ['zebraRef']);
});

test('the alias is a PAGE property, on the file\'s first line and with no bullet', () => {
  const anchor = RG.PAGES[`${RG.ANCHOR}.md`];
  assert.ok(anchor.startsWith(`alias:: ${RG.ALIAS}\n`),
    'written as a block property instead, the alias page is never created and the ' +
    'source page that mentions it is missing from the list — which is what the ' +
    'first baseline run of this fixture measured');
});

test('one referencing block is a child of another, so a block is drawn twice', () => {
  const na = RG.PAGES[`${RG.NA}.md`];
  const refAt = na.indexOf(RG.UUID.naRef);
  const childAt = na.indexOf(RG.UUID.naChild);
  assert.ok(refAt > 0 && childAt > refAt, 'naChild must be written under naRef');
  assert.ok(RG.REFERENCING.includes('naRef') && RG.REFERENCING.includes('naChild'));
});

test('one reference sits deep enough that OG\'s breadcrumb elides its path', () => {
  const apple = RG.PAGES[`${RG.APPLE}.md`];
  const ancestors = ['appleA1', 'appleA2', 'appleA3', 'appleA4', 'appleA5'];
  let last = -1;
  for (const a of ancestors) {
    const at = apple.indexOf(RG.UUID[a]);
    assert.ok(at > last, `${a} must be written outside the level below it`);
    last = at;
  }
  assert.ok(apple.indexOf(RG.UUID.appleRef) > last,
    'the reference must be under all five');
  assert.ok(ancestors.length > 3,
    "OG's breadcrumb shows three ancestors and emits `⋯` for a fourth; without more " +
    'than three there is no source-path control on this fixture');
});

test('one reference has a descendant past the level OG draws', () => {
  const zebra = RG.PAGES[`${RG.ZEBRA}.md`];
  const depthOf = (uuid) => {
    const line = zebra.split('\n').find((l) => l.includes(uuid));
    return (line.match(/^\t*/) || [''])[0].length;
  };
  assert.strictEqual(depthOf(RG.UUID.zebraRef), 1);
  assert.strictEqual(depthOf(RG.UUID.zebraC1), 2);
  assert.strictEqual(depthOf(RG.UUID.zebraG1), 3);
  assert.strictEqual(depthOf(RG.UUID.zebraGG1), 4);
  assert.ok(depthOf(RG.UUID.zebraGG1) - depthOf(RG.UUID.zebraRef) > 2,
    '`ref/default-open-blocks-level` is 2, so a third level below the reference is ' +
    'what makes OG collapse the row above it and the child-context control appear');
});

test('the control page is named by nothing and referenced by nothing', () => {
  const body = RG.PAGES['F28 Order Control.md'];
  assert.ok(body, 'the control page must exist');
  const others = Object.entries(RG.PAGES)
    .filter(([f]) => f !== 'F28 Order Control.md').map(([, b]) => b).join('\n');
  assert.ok(!others.includes('F28 Order Control'), 'nothing may point at it');
  assert.ok(!RG.journalBody().includes('F28 Order Control'));
});

test('nothing in the fixture carries a word the baseline sweeps for', () => {
  // `reforder-baseline-checks.js` sweeps the section's CONTROLS for
  // order/sort/정렬/순서 to establish that OG offers none. A fixture page named
  // with one of those words would make that sweep answer a question about the
  // fixture rather than about OG.
  const sortWord = /order|sort|정렬|순서/i;
  for (const title of [RG.ANCHOR, RG.ALIAS, RG.APPLE, RG.BANANA, RG.ZEBRA,
                       RG.GA, RG.NA, RG.DA, RG.HA]) {
    assert.ok(!sortWord.test(title), `${title} would confuse the baseline's sweep`);
  }
});

// --- the mirror -------------------------------------------------------------

test('the mirror keys a title exactly as the specification says', () => {
  assert.strictEqual(RG.sortKey('Banana Source'), 'banana source');
  assert.strictEqual(RG.sortKey(null), '');
  assert.strictEqual(RG.sortKey('하'.normalize('NFD')), '하');
});

test('the mirror compares by code point, not by UTF-16 code unit', () => {
  assert.ok(RG.compareTitles('豈', '🍎') < 0, 'U+F900 is below U+1F34E');
  assert.strictEqual(RG.codePoints('🍎').length, 1);
});

test('the mirror leaves ties in the order it was handed, in both directions', () => {
  const entries = [{ id: 1, title: 'Tie' }, { id: 2, title: 'tie' },
                   { id: 3, title: 'a' }];
  assert.deepStrictEqual(RG.orderTitles(entries, 'title-asc').map((e) => e.id), [3, 1, 2]);
  assert.deepStrictEqual(RG.orderTitles(entries, 'title-desc').map((e) => e.id), [1, 2, 3]);
});

test('the mirror hands the original order back untouched', () => {
  const entries = [{ id: 1, title: 'b' }, { id: 2, title: 'a' }];
  assert.deepStrictEqual(RG.orderTitles(entries, 'original').map((e) => e.id), [1, 2]);
});

test('the fixture builds nowhere but inside the permitted root', () => {
  const src = require('fs').readFileSync(
    path.join(__dirname, '..', 'checks', 'make-reforder-graph.js'), 'utf8');
  assert.match(src, /assertInsideAllowedRoot/);
  assert.match(src, /refusing to reuse another run/,
    'an existing folder must never be reused, renamed or reset');
  assert.ok(!/rmSync|unlinkSync|rmdirSync|renameSync/.test(src),
    'nothing here may delete, rename or reset anything');
});
