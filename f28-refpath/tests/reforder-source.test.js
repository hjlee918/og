'use strict';
//
// The F28 SOURCE-PAGE GROUP ORDERING — properties of the SOURCE SHAPE.
//
// What is asserted here is what a rendered outcome cannot show:
//
//   * `:original` hands OG's OWN expression back untouched, rather than a
//     reconstruction of it that happens to agree today;
//   * the ordering runs AFTER OG's own `sort-by`, over what OG produced;
//   * the groups are keyed by the page's `:db/id` — never by the title, which
//     is the thing being sorted — so a group survives being moved instead of
//     being rebuilt in its new place;
//   * the comparison is defined here and delegated to no locale;
//   * the choice is LOCAL to the view: no graph write, no config key, no app
//     state, no synchronisation;
//   * the surface rules are inherited from the source-path slice rather than
//     restated, and the control is offered on one surface only;
//   * nothing in the feature transacts, deduplicates or reaches into a group.
//
// Nothing here launches an application or touches a graph.
//
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');

const BLOCK_CLJS = path.join(REPO, 'src', 'main', 'frontend', 'components', 'block.cljs');
const REF_CLJS = path.join(REPO, 'src', 'main', 'frontend', 'components', 'reference.cljs');
const ORDER_CLJS = path.join(REPO, 'src', 'main', 'frontend', 'util', 'f28_reforder.cljs');
const EN = path.join(REPO, 'src', 'resources', 'dicts', 'en.edn');
const KO = path.join(REPO, 'src', 'resources', 'dicts', 'ko.edn');
const CSS = path.join(REPO, 'src', 'main', 'frontend', 'components', 'block.css');
const BASELINE = path.join(REPO, 'f28-refpath', 'checks', 'reforder-baseline-checks.js');
const FEATURE = path.join(REPO, 'f28-refpath', 'checks', 'reforder-feature-checks.js');
const READER = path.join(REPO, 'f28-refpath', 'checks', 'reforder-read.js');

function read(p) { return fs.readFileSync(p, 'utf8'); }

/**
 * The CODE of a Clojure source, with `;;` comments and every string literal
 * removed.
 *
 * Written after the first run of this file failed five of its own assertions
 * against the PROSE that explains the very rules they check — the docstring
 * saying "not the ascending list reversed" tripped the test forbidding
 * `reverse`, and so on four more times. A source-shape test that a comment can
 * fail is a test about comments.
 */
function code(src) {
  let out = '';
  let inString = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inString) {
      if (c === '\\') { i += 1; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += '""'; continue; }
    if (c === ';') { while (i < src.length && src[i] !== '\n') i += 1; out += '\n'; continue; }
    out += c;
  }
  return out;
}

/** One top-level form out of a source, by its opening text. */
function form(src, head) {
  const at = src.indexOf(head);
  assert.ok(at >= 0, `${head} was renamed or removed`);
  let depth = 0;
  let inString = false;
  for (let i = at; i < src.length; i++) {
    const c = src[i];
    if (inString) {
      if (c === '\\') { i += 1; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === ';') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (c === '(') depth += 1;
    else if (c === ')') { depth -= 1; if (depth === 0) return src.slice(at, i + 1); }
  }
  assert.fail(`${head} is unbalanced`);
  return '';
}

/** The `(:ref? config)`+`:group-by-page?` branch of `->hiccup` — this list. */
function refBranch() {
  const src = read(BLOCK_CLJS);
  const start = src.indexOf('(and (:ref? config) (:group-by-page? config))');
  assert.ok(start > 0, "->hiccup's linked-references branch was renamed or removed");
  const end = src.indexOf('(and (:group-by-page? config)', start);
  assert.ok(end > start, 'the branch after it was renamed or removed');
  return src.slice(start, end);
}

// --- OG's own order stays OG's own -----------------------------------------

test("OG's own ordering expression is still there, unmodified", () => {
  const branch = refBranch();
  assert.match(branch, /\(sort-by \(comp :block\/journal-day first\) > blocks\)/,
    "OG's own group ordering must be the expression this feature sorts, not one it replaced");
});

test('this feature orders what OG produced, not the raw groups', () => {
  const branch = refBranch();
  const call = form(branch, '(f28-order-groups');
  assert.match(call, /\(sort-by \(comp :block\/journal-day first\) > blocks\)/,
    "f28-order-groups must be handed OG's own sorted sequence");
});

test("`:original` returns the caller's sequence itself", () => {
  const order = form(read(ORDER_CLJS), '(defn order-groups');
  assert.match(order, /\(if \(= :original mode\)\s*\n\s*entries/,
    ':original must hand `entries` back, not re-sort into something equal to it');
});

test('an unknown order is OG\'s own order, never a guess', () => {
  const norm = form(read(ORDER_CLJS), '(defn normalize-mode');
  assert.match(norm, /default-mode/);
  assert.match(read(ORDER_CLJS), /\(def \^:const default-mode :original\)/);
});

// --- identity through reordering -------------------------------------------

test('each group is keyed by the page identity, so it survives being moved', () => {
  const branch = refBranch();
  assert.match(branch, /\(rum\/with-key\s*\n\s*\(ui\/lazy-visible/,
    'the lazy-visible wrapper must carry the key; a key on the div inside the ' +
    'closure is invisible to React and reconciles this list by POSITION');
  const forForm = form(branch, '(for [[page page-blocks] blocks]');
  const keyAt = forForm.lastIndexOf('(:db/id page)');
  assert.ok(keyAt > 0, 'the key must be the page\'s :db/id');
});

test('a title is never a component identity', () => {
  const branch = code(refBranch());
  assert.ok(!/with-key[\s\S]{0,200}original-name/.test(branch),
    'a group key made from the title would tie identity to the thing being sorted');
  assert.ok(!/:key\b/.test(code(read(ORDER_CLJS))),
    'the pure rule renders nothing and keys nothing');
});

// --- the comparison ---------------------------------------------------------

test('the key is OG\'s own NFC and lower-case mandate', () => {
  const key = form(read(ORDER_CLJS), '(defn sort-key');
  assert.match(key, /\.normalize.*"NFC"/, 'NFC is what OG normalises :block/name with');
  assert.match(key, /string\/lower-case/, 'lower-casing is the other half of that mandate');
});

test('no locale collation anywhere in the rule', () => {
  const order = code(read(ORDER_CLJS));
  for (const banned of ['localeCompare', 'Intl', 'toLocaleLowerCase', 'toLocaleUpperCase']) {
    assert.ok(!order.includes(banned),
      `${banned} would make the order depend on the reader's machine`);
  }
});

test('comparison is by code point, not by UTF-16 code unit', () => {
  const cp = form(read(ORDER_CLJS), '(defn code-points');
  assert.match(cp, /codePointAt/);
  assert.match(cp, /0xFFFF/, 'a surrogate pair must advance two units');
  const cmp = form(read(ORDER_CLJS), '(defn compare-code-points');
  assert.match(cmp, /code-points/);
});

test('descending negates the comparison rather than reversing the list', () => {
  const order = code(form(read(ORDER_CLJS), '(defn order-groups'));
  assert.match(order, /sign \(if \(= :title-desc mode\) -1 1\)/);
  assert.ok(!/reverse/.test(order),
    'reversing would mirror ties instead of leaving them in OG\'s order');
  assert.match(order, /\(sort \(fn \[a b\] \(\* sign/,
    'and it must be `sort`, which is goog.array/stableSort, so ties keep their order');
});

// --- where the control belongs ----------------------------------------------

test('the surface rules are the source-path slice\'s, delegated not restated', () => {
  const ex = form(read(ORDER_CLJS), '(defn excluded-surface');
  assert.match(ex, /f28\/excluded-surface/,
    'every shared exclusion must be answered by frontend.util.f28-refpath');
  assert.match(ex, /:not-order-list/, 'and this slice adds exactly its own one');
  const order = read(ORDER_CLJS);
  for (const reason of ['sidebar', 'block-refs-list', 'query', 'embed', 'html-export',
                        'whiteboard', 'preview', 'slide', 'mobile', 'f27-panel']) {
    assert.ok(!new RegExp(`${reason}\\?\\s`).test(ex),
      `${reason}? must not be re-tested here; it is the shared rule's`);
  }
  assert.match(order, /own-exclusion-reasons\s*\n\s*"[\s\S]*?"\s*\n\s*\[:not-order-list\]/,
    'the reasons must be data, so widening them is a visible change');
});

test('only `references*` opts a list in, and never the sidebar\'s copy', () => {
  const ref = read(REF_CLJS);
  assert.match(ref, /\(when source-path\? \(::group-order state\)\)/,
    'the sidebar\'s copy must be handed no ordering state at all');
  const block = read(BLOCK_CLJS);
  const surface = form(block, '(defn- f28-group-order');
  assert.match(surface, /f28ord\/offer-control\?/);
  assert.match(surface, /:order-list\? \(boolean \(:f28\/source-path\? config\)\)/,
    'the opt-in is the same explicit key the other F28 slices read');
});

test('the block-level reference list and custom queries are not this surface', () => {
  const ref = read(REF_CLJS);
  const blockRefs = form(ref, '(rum/defc block-linked-references');
  assert.ok(!blockRefs.includes(':f28/group-order'),
    'a block\'s own reference list gets no ordering');
  assert.match(blockRefs, /:f28\/block-refs-list\? true/);
});

// --- the control itself ------------------------------------------------------

test('the control is one select, keyboard-operable, and says what it chose', () => {
  const ctl = form(read(REF_CLJS), '(rum/defc f28-group-order-control');
  assert.match(ctl, /:select\.f28-order-select/);
  assert.match(ctl, /:data-f28-order \(f28ord\/mode-value mode\)/,
    'a check must be able to read the DECISION rather than the translated word');
  assert.match(ctl, /:aria-label \(t :f28\/order-label\)/);
  assert.match(ctl, /:title \(t :f28\/order-why\)/);
  assert.ok(!/:tabindex|:tab-index/i.test(ctl),
    'a select is focusable on its own; a tabindex would only be able to make it worse');
});

test('the control stops propagation and never prevents the default action', () => {
  const ctl = code(form(read(REF_CLJS), '(rum/defc f28-group-order-control'));
  assert.match(ctl, /:on-mouse-down util\/stop-propagation/,
    'the foldable header calls util/stop on mouse-down, which would stop the select opening');
  assert.match(ctl, /:on-key-down util\/stop-propagation/,
    "OG's global shortcut handler prevents the default action of keys a select is driven by");
  assert.ok(!/util\/stop[^-]/.test(ctl),
    'util/stop prevents the default action, which IS the control working');
});

test('the control follows the interface language reactively', () => {
  const ref = read(REF_CLJS);
  assert.match(ref, /\(rum\/defc f28-group-order-control < rum\/reactive/,
    'without the subscription the words stay in the old language until something ' +
    'else redraws the row — measured in the reference-role slice\'s first run');
  const ctl = form(ref, '(rum/defc f28-group-order-control');
  assert.match(ctl, /\(t \(f28ord\/label-key m\)\)/, 'every word comes from the dictionary');
  const literals = form(ref, '(rum/defc f28-group-order-control')
    .slice(ctl.indexOf('[*group-order]'))
    .match(/"[^"]*"/g) || [];
  assert.deepStrictEqual(literals, [],
    'no words of its own in the component body; every one comes from the dictionary');
});

test('the list re-renders on the choice without re-running the query', () => {
  const ref = read(REF_CLJS);
  assert.match(ref, /\(rum\/defc references-inner < rum\/reactive/);
  const inner = form(ref, '(rum/defc references-inner');
  assert.match(inner, /\(when \*group-order \(rum\/react \*group-order\)\)/);
  assert.match(inner, /:f28\/group-order group-order/);
});

// --- local to this view ------------------------------------------------------

test('the choice is a rum/local and reaches no store of any kind', () => {
  const ref = read(REF_CLJS);
  assert.match(ref, /\(rum\/local :original ::group-order\)/,
    'the choice must start at OG\'s own order and live only as long as the view');
  const ctl = form(ref, '(rum/defc f28-group-order-control');
  for (const banned of ['save-filter!', 'set-config!', 'config.edn', 'localStorage',
                        'state/set-state!', 'transact', 'set-state!', 'persist']) {
    assert.ok(!ctl.includes(banned), `${banned} would make this choice more than a view's`);
  }
});

test('nothing in the feature writes, converts or reaches into a group', () => {
  const order = code(read(ORDER_CLJS));
  for (const banned of ['db/transact', 'db/entity', 'db/pull', 'model/', 'outliner',
                        'save-filter', 'distinct', 'dedupe', 'assoc-in', 'reset!', 'swap!']) {
    assert.ok(!order.includes(banned),
      `${banned} has no place in a pure ordering rule`);
  }
  const branch = code(refBranch());
  assert.ok(!/distinct|dedupe/.test(branch),
    'a block that legitimately appears twice must keep both appearances');
});

test('the title is read through the lookup the renderer already makes', () => {
  const title = form(read(BLOCK_CLJS), '(defn- f28-group-title');
  assert.match(title, /\(db\/entity \(:db\/id page\)\)/,
    'the same lookup ->hiccup performs to render the header');
  assert.match(title, /:block\/original-name/);
  const branch = refBranch();
  assert.match(branch, /\(db\/entity \(:db\/id page\)\)/,
    'and the renderer still makes it');
});

// --- the words ---------------------------------------------------------------

test('every dictionary key the control uses exists in English and Korean', () => {
  const keys = [':f28/order-label', ':f28/order-why', ':f28/order-original',
                ':f28/order-title-asc', ':f28/order-title-desc'];
  const en = read(EN);
  const ko = read(KO);
  for (const k of keys) {
    assert.ok(en.includes(`${k} "`), `${k} missing from en.edn`);
    assert.ok(ko.includes(`${k} "`), `${k} missing from ko.edn`);
  }
});

test("the explanation says the three things a reader needs and does not overclaim", () => {
  const en = read(EN);
  const line = en.split('\n').find((l) => l.includes(':f28/order-why'));
  assert.ok(/Nothing inside a group moves/.test(line), 'what does not move');
  assert.ok(/nothing is written to your notes/.test(line), 'that it is read-only');
  assert.ok(/not saved/.test(line), 'that the choice does not persist');
});

// --- appearance is removable -------------------------------------------------

test('every rule this feature adds is scoped to its own class', () => {
  const css = read(CSS);
  const start = css.indexOf('F28 source-page group ordering');
  assert.ok(start > 0, 'the ordering section of the stylesheet was renamed or removed');
  const section = css.slice(start);
  for (const rule of section.split('\n').filter((l) => /^\S.*\{$/.test(l))) {
    assert.match(rule, /\.f28-order/,
      `${rule.trim()} reaches outside this feature, so removing it would leave a change behind`);
  }
});

// --- the scenarios -----------------------------------------------------------

test('the baseline run refuses to measure OG inside a build containing the feature', () => {
  const b = read(BASELINE);
  assert.match(b, /f28_reforder/);
  assert.match(b, /this build contains the feature; it cannot establish the baseline/);
});

test('both scenarios settle before every reading', () => {
  const r = read(READER);
  assert.match(r, /stable < 3/,
    'a reading of this list is only a reading once the row count is stable');
  assert.match(r, /lazy-visible|IntersectionObserver/,
    'and the reason must be written down beside it');
  for (const f of [BASELINE, FEATURE]) {
    if (!fs.existsSync(f)) continue;
    const s = read(f);
    assert.match(s, /makeSettle/, `${path.basename(f)} must settle through the shared reader`);
    assert.ok(!/\bpage\.evaluate\(\(\)\s*=>\s*document\.querySelectorAll\('\.references/.test(s),
      `${path.basename(f)} must read through the shared reader, not its own copy`);
  }
});

test('a group is identified by data-ref, never by its title text', () => {
  const r = read(READER);
  assert.match(r, /getAttribute\('data-ref'\)/,
    'data-ref is page-name-sanity-lc — OG\'s own identity mandate');
  assert.match(r, /NEVER BY ITS TITLE TEXT/,
    'and the reason must be written down, because it is what keeps the assertion ' +
    'from being circular');
});
