'use strict';
//
// The F28 REFERENCE-ROLE labels — properties of the SOURCE SHAPE.
//
// Row 8 of `project-notes/F28_CHILD_CONTEXT_SPEC.md` §1: in a page's
// linked-references list a counted mention and a child drawn beneath it are
// rendered identically, and nothing visible says which is which. This slice
// adds one inert word per row saying why the row is there.
//
// What is asserted here is what a rendered outcome cannot show:
//
//   * the role is decided from the block's OWN refs and the page's identity
//     set, and from nothing else — not indentation, not level, not text, not
//     `:ref-query-child?`;
//   * the page identity is the SAME set `references*` counts the heading with,
//     so a label and the count cannot disagree;
//   * the label is inert — no button, no handler, no tabindex, no href;
//   * the surface rules are inherited from the source-path slice rather than
//     restated;
//   * nothing in the feature writes, navigates, sorts or converts.
//
// Nothing here launches an application or touches a graph.
//
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const STATIC = path.join(REPO, 'static');

const BLOCK_CLJS = path.join(REPO, 'src', 'main', 'frontend', 'components', 'block.cljs');
const REF_CLJS = path.join(REPO, 'src', 'main', 'frontend', 'components', 'reference.cljs');
const ROLE_CLJS = path.join(REPO, 'src', 'main', 'frontend', 'util', 'f28_refrole.cljs');

function read(p) { return fs.readFileSync(p, 'utf8'); }

/** The role feature's own region of block.cljs. */
function roleRegion() {
  const src = read(BLOCK_CLJS);
  const start = src.indexOf('(defn- f28-row-role');
  const end = src.indexOf(';; F28 child context — what is written UNDER a linked reference.');
  assert.ok(start > 0 && end > start, 'the F28 reference-role region was renamed or removed');
  return { all: src, region: src.slice(start, end) };
}

/** One top-level form out of a region, by its opening text. */
function form(region, head) {
  const at = region.indexOf(head);
  assert.ok(at >= 0, `${head} was renamed or removed`);
  let depth = 0;
  for (let i = at; i < region.length; i++) {
    if (region[i] === '(') depth += 1;
    else if (region[i] === ')') { depth -= 1; if (depth === 0) return region.slice(at, i + 1); }
  }
  assert.fail(`${head} is unbalanced`);
  return '';
}

/** `block-container-inner`'s body. */
function containerInner() {
  const src = read(BLOCK_CLJS);
  const start = src.indexOf('(rum/defc ^:large-vars/cleanup-todo block-container-inner');
  const end = src.indexOf('(defn- attach-order-list-state!');
  assert.ok(start > 0 && end > start, 'block-container-inner was renamed or removed');
  return src.slice(start, end);
}

// --- the semantics ----------------------------------------------------------

test('the role is decided by the pure namespace, not by an inline cond', () => {
  const { region } = roleRegion();
  assert.match(region, /f28role\/row-role/,
    'the role must come from frontend.util.f28-refrole');
  assert.match(region, /f28role\/describe/,
    'and what it says must come from there too');
  assert.match(region, /f28role\/label-rows\?/,
    'and whether this surface labels rows at all');
});

test('the role is decided from the block\'s OWN refs and the page\'s identity', () => {
  const { region } = roleRegion();
  const fn = form(region, '(defn- f28-row-role');
  assert.match(fn, /:ref-ids \(map :db\/id refs\)/,
    'the role must be decided from the block\'s own :block/refs');
  assert.match(fn, /:page-ids page-ids/,
    'and from the page identity the list opted in with');
  assert.match(fn, /page-ids \(:f28\/role-pages config\)/,
    'which must be read from the config key references* sets');
});

test('the role cannot see where the row is drawn', () => {
  // The one rule the whole namespace exists for. `nested?` reaches `describe`,
  // which picks a longer SENTENCE, and must not reach `row-role`.
  const { region } = roleRegion();
  const fn = form(region, '(defn- f28-row-role');
  const call = fn.slice(fn.indexOf('(f28role/row-role'));
  const rowRole = call.slice(0, call.indexOf('}') + 1);
  for (const forbidden of ['nested?', 'level', 'ref-query-child?', 'parent',
                           'content', 'depth', 'indent']) {
    assert.ok(!rowRole.includes(forbidden),
      `row-role is handed ${forbidden}; the role is a property of the block, not of the row`);
  }
  assert.match(fn, /:nested\? nested\?/,
    'nested? must still reach describe, which picks the sentence');
});

test('the pure namespace itself refuses position, text and repetition', () => {
  const src = read(ROLE_CLJS);
  const start = src.indexOf('(defn row-role');
  const end = src.indexOf('(defn describe');
  assert.ok(start > 0 && end > start, 'row-role was renamed or removed');
  const fn = src.slice(start, end);
  const body = fn.slice(fn.indexOf('[{:keys'));
  for (const forbidden of ['level', 'nested', 'ref-query-child', 'parent',
                           'content', 'depth', 'string/', 'count ']) {
    assert.ok(!body.includes(forbidden),
      `row-role reads ${forbidden}; the role must depend only on refs and the page`);
  }
  assert.match(body, /direct-mention\?/, 'it must be the one predicate');
});

test('the predicate is references*\'s own, so a label and the count cannot disagree', () => {
  const ref = read(REF_CLJS);
  // The count: `top-level-blocks` filters ref-blocks by alias-set membership of
  // the block's own refs.
  assert.match(ref, /top-level-blocks \(filter \(fn \[b\] \(some aliases \(set \(map :db\/id \(:block\/refs b\)\)\)\)\) ref-blocks\)/,
    'OG\'s own counted-mention predicate changed; the role definition must be revisited');
  // The label: the same `aliases` set is what the list hands down.
  assert.match(ref, /\(when source-path\? aliases\)/,
    'the page identity handed to the rows must be the same alias set the count uses');
  assert.match(ref, /:f28\/role-pages role-pages/,
    'and it must travel as its own config key');
});

test('the right sidebar\'s copy of the list is handed no page identity at all', () => {
  const ref = read(REF_CLJS);
  const at = ref.indexOf('(when source-path? aliases)');
  assert.ok(at > 0);
  // `source-path?` is `(not (:sidebar? opts))`, so the sidebar's copy gets nil
  // and `page-known?` is false there — belt as well as the inherited :sidebar
  // exclusion.
  assert.match(ref, /source-path\? \(not \(:sidebar\? opts\)\)/,
    'the sidebar opt-out must remain the one the source-path slice established');
});

// --- inert ------------------------------------------------------------------

test('the label is inert: no button, no handler, no keyboard stop', () => {
  const { region } = roleRegion();
  const cp = form(region, '(rum/defc f28-ref-role');
  assert.match(cp, /\[:span\.f28-role/, 'the label must be a span');
  for (const forbidden of [':button', 'f27-btn', ':on-click', ':on-key-down',
                           ':on-mouse-down', ':tabindex', ':tab-index', ':href',
                           'route-handler', 'state/sidebar', ':aria-expanded']) {
    assert.ok(!cp.includes(forbidden),
      `the role label carries ${forbidden}; it explains a row, it is not a place to go`);
  }
});

test('the label carries the decision as data, not only as a translated word', () => {
  const { region } = roleRegion();
  const cp = form(region, '(rum/defc f28-ref-role');
  assert.match(cp, /:data-f28-role \(name role\)/,
    'a check must be able to read the role rather than the dictionary');
});

test('the feature reads no database and writes nothing', () => {
  const { region } = roleRegion();
  for (const forbidden of ['db/entity', 'db/pull', 'db/transact', 'model/',
                           'outliner', 'save-block', 'set-collapsed',
                           'build-plan', 'sort-by', 'page-handler']) {
    assert.ok(!region.includes(forbidden),
      `the role feature reaches ${forbidden}; it is a read of what the row already has`);
  }
});

test('deciding a row\'s role costs no new query in block-container-inner', () => {
  const inner = containerInner();
  assert.match(inner, /ref-role \(f28-row-role config refs \(boolean \(:ref-query-child\? config\)\)\)/,
    'the role must be computed from locals this component already has');
  // `refs` is the same local `data-refs-self` is built from, one line above.
  const at = inner.indexOf('data-refs-self (build-refs-data-value refs)');
  const roleAt = inner.indexOf('ref-role (f28-row-role');
  assert.ok(at > 0 && roleAt > at,
    'the role must be derived beside the attribute built from the same refs');
});

test('the label is rendered once, inside the row it describes', () => {
  const inner = containerInner();
  assert.strictEqual((inner.match(/\(f28-ref-role /g) || []).length, 1,
    'the label must be rendered in exactly one place');
  const mainStart = inner.indexOf('[:div.block-main-container');
  const childrenStart = inner.indexOf('(block-children config block children collapsed?)');
  const labelAt = inner.indexOf('(when ref-role (f28-ref-role ref-role))');
  assert.ok(mainStart > 0 && labelAt > mainStart && labelAt < childrenStart,
    'the label must sit inside the row\'s own main container, before its children');
  // Every block in the application reaches this line. Only the rows of one
  // linked-references list have a role, and nothing may be mounted for the rest.
  assert.match(inner, /\(when ref-role \(f28-ref-role ref-role\)\)/,
    'the label component must not be mounted where there is no role');
});

test('the label follows the interface language', () => {
  // `t` reads the language through `state/sub`, and `frontend.util/react`
  // degrades to a plain deref outside a reactive component — the right word is
  // rendered, but nothing subscribes. The first packaged run measured exactly
  // that: the language changed and every label stayed English.
  const { region } = roleRegion();
  assert.match(region, /\(rum\/defc f28-ref-role < rum\/reactive/,
    'the label must subscribe to the language it renders');
  const cp = form(region, '(rum/defc f28-ref-role');
  assert.match(cp, /\(t why-key\)/, 'the sentence must be translated');
  assert.match(cp, /\(t text-key\)/, 'and so must the word');
});

// --- inherited surface rules ------------------------------------------------

test('the surface rules are the source-path slice\'s, delegated rather than restated', () => {
  const src = read(ROLE_CLJS);
  assert.match(src, /f28\/excluded-surface/,
    'the shared exclusions must be delegated to the source-path slice');
  assert.match(src, /\(not role-list\?\)\s+:not-role-list/);
  assert.match(src, /\(not page-known\?\)\s+:unknown-page/);
  for (const restated of [':sidebar ', ':query ', ':preview ', ':embed ',
                          ':whiteboard ', ':html-export ', ':block-refs-list ',
                          ':mobile ', ':slide ', ':f27-panel ']) {
    assert.ok(!src.includes(restated),
      `f28-refrole restates ${restated.trim()}; it must inherit it and cannot be allowed to drift`);
  }
});

test('the opt-in is the same explicit one the other F28 slices read', () => {
  const { region } = roleRegion();
  const fn = form(region, '(defn- f28-row-role');
  assert.match(fn, /:role-list\? \(boolean \(:f28\/source-path\? config\)\)/,
    'the surface must SAY it is this list rather than be inferred from flags');
  assert.match(fn, /\(f28-surface config\)/,
    'and every other surface question must be the shared mapping');
});

// --- the words --------------------------------------------------------------

test('every string this feature shows exists in English and Korean', () => {
  const keys = [':f28/role-direct', ':f28/role-context', ':f28/role-direct-why',
                ':f28/role-direct-again-why', ':f28/role-context-why'];
  const en = read(path.join(REPO, 'src', 'resources', 'dicts', 'en.edn'));
  const ko = read(path.join(REPO, 'src', 'resources', 'dicts', 'ko.edn'));
  for (const k of keys) {
    const enLine = en.split('\n').find((l) => l.trim().startsWith(`${k} `));
    assert.ok(enLine, `${k} is missing from en.edn`);
    const koLine = ko.split('\n').find((l) => l.trim().startsWith(`${k} `));
    assert.ok(koLine, `${k} is missing from ko.edn`);
    assert.match(koLine, /[가-힣]/, `${k} is not translated`);
  }
});

test('the compact words stay compact, because they appear on every row', () => {
  for (const dict of ['en.edn', 'ko.edn']) {
    const d = read(path.join(REPO, 'src', 'resources', 'dicts', dict));
    for (const k of [':f28/role-direct', ':f28/role-context']) {
      const line = d.split('\n').find((l) => l.trim().startsWith(`${k} `));
      const text = line.slice(line.indexOf('"') + 1, line.lastIndexOf('"'));
      assert.ok(text.length > 0 && text.length <= 12,
        `${k} in ${dict} is "${text}" — a word on every row must stay short`);
      assert.ok(!text.includes(' ') || text.split(' ').length <= 2,
        `${k} in ${dict} is a phrase, not a word`);
    }
  }
});

test('the sentence for a direct mention never says it is only context', () => {
  const en = read(path.join(REPO, 'src', 'resources', 'dicts', 'en.edn'));
  const why = en.split('\n').find((l) => l.trim().startsWith(':f28/role-direct-why '));
  const again = en.split('\n').find((l) => l.trim().startsWith(':f28/role-direct-again-why '));
  for (const line of [why, again]) {
    assert.match(line, /mentions this page/,
      'a direct mention\'s sentence must say it mentions the page');
    assert.ok(!/does not mention/.test(line),
      'a direct mention must never be described as not mentioning the page');
  }
  assert.match(again, /shown here again/,
    'the repeated appearance must be explained where it happens');
});

// --- scoped -----------------------------------------------------------------

test('the feature is scoped in CSS, so removing it removes its appearance', () => {
  const css = read(path.join(REPO, 'src', 'main', 'frontend', 'components', 'block.css'));
  const at = css.indexOf('F28 reference roles');
  assert.ok(at > 0, 'the reference-role CSS block was renamed or removed');
  const block = css.slice(at);
  const selectors = [...block.matchAll(/^\.([a-z0-9-]+)/gm)].map((m) => m[1]);
  assert.ok(selectors.length >= 3, 'too few rules to be this feature\'s appearance');
  for (const s of selectors) {
    assert.ok(s.startsWith('f28-role'),
      `${s} is not scoped to this feature; removing it would change OG's own styling`);
  }
});

test('the renderer carries the reference-role namespace', () => {
  const runtime = path.join(STATIC, 'js', 'cljs-runtime');
  assert.ok(fs.existsSync(runtime), 'no compiled renderer in static/js/cljs-runtime');
  assert.ok(fs.readdirSync(runtime).includes('frontend.util.f28_refrole.js'),
    'the renderer does not carry frontend.util.f28_refrole.js');
});
