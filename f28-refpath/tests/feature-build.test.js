'use strict';
//
// The F28 SOURCE-PATH build's own identity and integrity checks.
//
// Two tests in the accepted pilot suite are about "the real built application
// directory in this checkout":
//
//   guards.test.js    'the compiled pilot bundle is the one the manifest describes'
//   preflight.test.js 'the real built application directory passes its own preflight'
//
// In THIS checkout that directory holds the feature build, not a pilot build,
// so those two are skipped by `scripts/run-feature-tests.js` — by name, in one
// visible place — and replaced here. The pilot test files themselves are NOT
// modified: they remain exactly right for a pilot build, including their pin on
// the accepted renderer revision `5b34566ca`, which this build must NOT satisfy
// and is asserted below to not satisfy.
//
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = path.resolve(__dirname, '..', '..');
const STATIC = path.join(REPO, 'static');
const ID = require(path.join(REPO, 'f28-refpath', 'src', 'feature-identity.js'));
const PILOT_ID = require(path.join(REPO, 'f27-pilot', 'src', 'pilot-identity.js'));

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const manifestPath = path.join(STATIC, ID.MANIFEST_FILE);
const built = fs.existsSync(manifestPath);

// `static/` is ONE scratch directory shared by every build this checkout makes,
// so it holds whichever was built last. When it holds a DIFFERENT build, these
// assertions are asking the wrong question rather than finding an answer, and
// they say so by name instead of failing — the same treatment, and the same
// reason, as the two pilot tests `scripts/run-feature-tests.js` skips.
// The build that IS in static/ is asserted by its own suite.
const OTHER_BUILDS = {
  'origin-experiment-build-manifest.json': 'the ORIGIN EXPERIMENT (f28-origin/tests/experiment-build.test.js)',
};
const occupant = Object.keys(OTHER_BUILDS)
  .find((f) => !built && fs.existsSync(path.join(STATIC, f)));

function manifest() {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

test('a feature build is present in static/',
  { skip: occupant ? `static/ currently holds ${OTHER_BUILDS[occupant]}` : false }, () => {
    assert.ok(built,
      `no feature build present at ${manifestPath}; run f28-refpath/scripts/build-feature.js first`);
  });

test('the compiled main bundle is the one the manifest describes', { skip: !built }, () => {
  const m = manifest();
  const buf = fs.readFileSync(path.join(STATIC, ID.MAIN_BUNDLE));
  assert.strictEqual(sha256(buf), m.artifacts[ID.MAIN_BUNDLE].sha256);
  assert.strictEqual(buf.length, m.artifacts[ID.MAIN_BUNDLE].bytes);
  assert.strictEqual(m.closureDefines['electron.pilot/PILOT'], true);
});

test('every entry file that participates in startup is covered by the manifest',
  { skip: !built }, () => {
    const m = manifest();
    for (const f of ['pilot-main.js', 'pilot-preflight.js', 'pilot-isolation.js',
                     'pilot-identity.js', 'pilot-boundary.js']) {
      assert.ok(m.artifacts[f], `artifact not covered: ${f}`);
      const buf = fs.readFileSync(path.join(STATIC, f));
      assert.strictEqual(sha256(buf), m.artifacts[f].sha256, `${f} does not match the manifest`);
    }
  });

test('the built application directory passes its own preflight', { skip: !built }, () => {
  // Loaded from static/, so it resolves the identity that actually ships.
  const preflight = require(path.join(STATIC, 'pilot-preflight.js'));
  const v = preflight.verify(STATIC);
  assert.strictEqual(v.ok, true, `${v.reason}: ${v.detail}`);
  assert.ok(v.checks.length >= 10);
});

test('the shipped guard entry is the PILOT source, byte for byte', { skip: !built }, () => {
  for (const f of ['pilot-main.js', 'pilot-preflight.js', 'pilot-isolation.js',
                   'pilot-boundary.js']) {
    const shipped = fs.readFileSync(path.join(STATIC, f));
    const source = fs.readFileSync(path.join(REPO, 'f27-pilot', 'src', f));
    assert.strictEqual(sha256(shipped), sha256(source),
      `${f} shipped differs from the pilot source; the guards must be unchanged`);
  }
});

test('the shipped identity is the FEATURE identity and not the pilot\'s', { skip: !built }, () => {
  const shipped = require(path.join(STATIC, 'pilot-identity.js'));
  assert.strictEqual(shipped.PRODUCT_NAME, ID.PRODUCT_NAME);
  assert.strictEqual(shipped.BUNDLE_ID, ID.BUNDLE_ID);
  assert.notStrictEqual(shipped.PRODUCT_NAME, PILOT_ID.PRODUCT_NAME);
  assert.notStrictEqual(shipped.BUNDLE_ID, PILOT_ID.BUNDLE_ID);
  assert.notStrictEqual(shipped.PACKAGE_NAME, PILOT_ID.PACKAGE_NAME);
  assert.notStrictEqual(shipped.STATE_DIR, PILOT_ID.STATE_DIR);
  assert.notStrictEqual(shipped.OWNERSHIP_MARKER, PILOT_ID.OWNERSHIP_MARKER);
  // The guard markers must be IDENTICAL: they come from the same unchanged
  // guard source, and a different literal would mean different guards.
  assert.strictEqual(shipped.ACTIVE_MARKER, PILOT_ID.ACTIVE_MARKER);
  assert.strictEqual(shipped.INERT_MARKER, PILOT_ID.INERT_MARKER);
  assert.deepStrictEqual(shipped.GRAPH_ROOT_SEGMENTS, PILOT_ID.GRAPH_ROOT_SEGMENTS);
  // Likewise the boundary contract, which belongs to the compiled guard. A
  // stale shipped identity fails here rather than at run time, where it costs a
  // whole packaged session to discover.
  assert.strictEqual(shipped.BOUNDARY_SCHEMA, PILOT_ID.BOUNDARY_SCHEMA);
  assert.strictEqual(shipped.BOUNDARY_FILE, PILOT_ID.BOUNDARY_FILE);
});

test('the boundary contract belongs to the COMPILED guard, not to this build', () => {
  // Regression for a defect this batch's first live run found. Renaming the
  // boundary schema here left `graphRoot` nil in the main process, so the
  // application refused every graph path — including the permitted one — and
  // the run could not load its own synthetic graph. The guard failed closed,
  // which is right; the identity was wrong.
  //
  // The literals are read from the guard SOURCE, so this test tracks the guard
  // rather than restating a constant beside it.
  const guard = fs.readFileSync(
    path.join(REPO, 'src', 'electron', 'electron', 'pilot.cljs'), 'utf8');
  const schema = guard.match(/\(def \^:const BOUNDARY-SCHEMA "([^"]+)"\)/);
  const file = guard.match(/\(def \^:const BOUNDARY-FILE "([^"]+)"\)/);
  assert.ok(schema && file, 'could not read the boundary contract from pilot.cljs');

  for (const ID_ of [ID, PILOT_ID]) {
    assert.strictEqual(ID_.BOUNDARY_SCHEMA, schema[1],
      'the boundary schema must be exactly what the compiled guard accepts');
    assert.strictEqual(ID_.BOUNDARY_FILE, file[1],
      'the boundary file name must be exactly what the compiled guard reads');
  }
});

test('this build does not claim to be the accepted pilot renderer', { skip: !built }, () => {
  const m = manifest();
  assert.notStrictEqual(m.builtFrom.rendererRevision, '5b34566ca',
    'this renderer was rebuilt from the feature branch and must not carry the accepted revision');
  assert.strictEqual(m.builtFrom.branch, 'feature/f28-reference-paths');
  assert.strictEqual(m.rendererBuild.rebuiltHere, true);
  assert.strictEqual(m.rendererBuild.mode, 'compile');
  assert.strictEqual(m.rendererBuild.telemetryDefinesPresent, false);
  assert.strictEqual(m.schema, ID.SCHEMA);
  assert.notStrictEqual(m.schema, PILOT_ID.SCHEMA);
});

test('the renderer the manifest describes is the renderer on disk', { skip: !built }, () => {
  const m = manifest();
  const head = fs.readFileSync(path.join(STATIC, 'js', 'main.js'), 'utf8').slice(0, 4096);
  assert.match(head, new RegExp(`"frontend\\.config\\.REVISION":"${m.builtFrom.rendererRevision}"`));
  assert.ok(head.includes(`CLOSURE_BASE_PATH = '${m.rendererBuild.closureBasePath}'`));
  assert.strictEqual(m.rendererBuild.closureBasePath, '/static/js/cljs-runtime/',
    'a release build would point at https://asset.logseq.com/static/js');
  assert.doesNotMatch(head.match(/var CLOSURE_DEFINES = (\{[^}]*\})/)[1], /sentry|posthog/i);
});

test('the packaging configuration writes outside every accepted checkout',
  { skip: !built }, () => {
    const forge = require(path.join(STATIC, 'forge.config.js'));
    const out = path.resolve(forge.outDir);
    for (const name of ['f27-slice-1', 'f27-pilot', 'f27-outgoing-context']) {
      assert.ok(!out.split(path.sep).includes(name), `${out} is inside ${name}`);
    }
    // The checkout directory is shared with the F27 inline build on purpose;
    // what must differ is the packaged application inside it, which the bundle
    // id and product name below pin.
    assert.ok(out.split(path.sep).includes('f27-inline-context'), out);
    assert.strictEqual(forge.packagerConfig.appBundleId, ID.BUNDLE_ID);
    assert.ok(!forge.packagerConfig.protocols);
    assert.ok(!forge.packagerConfig.osxSign);
    assert.ok(!forge.packagerConfig.osxNotarize);
    assert.strictEqual((forge.makers || []).length, 0);
    assert.strictEqual((forge.publishers || []).length, 0);
  });

test("this build cannot claim either INHERITED feature build's state", () => {
  // Two earlier feature identities are still in this tree, inherited from the
  // base commit this branch was cut from. All three are unsigned local
  // artifacts that write into Application Support, so each must be as
  // distinguishable from the others as each is from the accepted pilot — and
  // this build shares its CHECKOUT with the F27 inline build, which makes the
  // separation of their built identities the only thing keeping them apart.
  for (const rel of [['f27-outgoing', 'src', 'feature-identity.js'],
                     ['f27-inline', 'src', 'feature-identity.js']]) {
    const OTHER = require(path.join(REPO, ...rel));
    for (const k of ['SCHEMA', 'PRODUCT_NAME', 'BUNDLE_ID', 'PACKAGE_NAME',
                     'STATE_DIR', 'OWNERSHIP_MARKER']) {
      assert.notStrictEqual(ID[k], OTHER[k], `${k} collides with ${rel[0]}`);
    }
    // …and the parts that belong to the compiled guard are shared, for the
    // same reason they are shared with the pilot.
    assert.strictEqual(ID.BOUNDARY_SCHEMA, OTHER.BOUNDARY_SCHEMA);
    assert.strictEqual(ID.BOUNDARY_FILE, OTHER.BOUNDARY_FILE);
    assert.strictEqual(ID.ACTIVE_MARKER, OTHER.ACTIVE_MARKER);
  }
});

test('every inherited build script refuses to run on this branch', () => {
  // Each pins its own branch, which this checkout is not on. That refusal is
  // why the inherited tooling can be kept in the tree with no chance of it
  // writing this checkout's application directory — and it matters more here
  // than it did before, because the F27 inline build's scripts are in the SAME
  // clone this branch is checked out in.
  const pinned = {
    'f27-outgoing': 'feature/f27-outgoing-context',
    'f27-inline': 'feature/f27-inline-context',
  };
  for (const [dir, branch] of Object.entries(pinned)) {
    const src = fs.readFileSync(path.join(REPO, dir, 'scripts', 'build-feature.js'), 'utf8');
    assert.ok(src.includes(`const FEATURE_BRANCH = '${branch}';`),
      `${dir} does not pin ${branch}`);
    assert.ok(!src.includes("const FEATURE_BRANCH = 'feature/f28-reference-paths';"),
      `${dir} would run on this branch`);
  }
  const mine = fs.readFileSync(
    path.join(REPO, 'f28-refpath', 'scripts', 'build-feature.js'), 'utf8');
  assert.match(mine, /const FEATURE_BRANCH = 'feature\/f28-reference-paths';/);
  assert.match(mine, /const PROTECTED_CHECKOUTS = \['f27-slice-1', 'f27-pilot', 'f27-outgoing-context'\];/);
});

test('a CLOSED control performs no ancestor walk — the one cost claim that is structural', () => {
  // The specification's original "one walk per press, nothing between presses"
  // was not true and has been corrected: the walk runs in the panel's render
  // body. What remains true, and is the claim that actually matters, is that a
  // closed control renders no panel at all. That is a property of the SOURCE
  // shape, so it is read out of the source rather than described.
  const src = fs.readFileSync(
    path.join(REPO, 'src', 'main', 'frontend', 'components', 'block.cljs'), 'utf8');

  const start = src.indexOf('(rum/defcs f28-source-path <');
  assert.ok(start > 0, 'f28-source-path was renamed or removed');
  const wrapper = src.slice(start, src.indexOf('(rum/defcs breadcrumb-with-container'));
  assert.match(wrapper, /\(when press\s*\n?\s*\(f28-source-path-panel/,
    'the panel must be rendered only when the control has been pressed');
  assert.ok(!wrapper.includes('load-ancestors'),
    'the wrapper, which renders for every group, must never walk ancestors itself');

  // And the walk must live in exactly one place, so "closed costs nothing"
  // cannot be quietly undone by a second call site.
  const panelStart = src.indexOf('(rum/defc f28-source-path-panel');
  assert.ok(panelStart > 0);
  const panel = src.slice(panelStart, start);
  assert.strictEqual((panel.match(/f27ctx\/load-ancestors/g) || []).length, 1);
  const f28Region = src.slice(src.indexOf('(defn- f28-panel-id'), start);
  assert.strictEqual((f28Region.match(/f27ctx\/load-ancestors/g) || []).length, 1,
    'the F28 source-path feature must contain exactly one ancestor walk, inside the panel');
});

// --- opening a disclosed level ----------------------------------------------
//
// The first slice left every step inert. Now one can be opened, which is the
// half where a wrong answer does real damage: OG's own `redirect-to-page!`
// CREATES a page when it is handed a name that does not resolve (#3511), and a
// path may legitimately contain several levels reading exactly the same words.
// Each rule below is read out of the source, because each is a property of the
// shape rather than of one rendered outcome.

/**
 * The F28 SOURCE-PATH feature's own source, from its panel id to OG's container.
 *
 * Bounded at `f28-panel-id` rather than at `f28-surface`: the surface decision
 * is shared with the child-context feature and therefore now sits above
 * `block-container-inner`, which renders that feature's control. A region that
 * still started there would swallow OG's own block renderer, and assertions
 * like "exactly one entity lookup" would be counting OG's lookups.
 */
function f28Source() {
  const src = fs.readFileSync(
    path.join(REPO, 'src', 'main', 'frontend', 'components', 'block.cljs'), 'utf8');
  const start = src.indexOf('(defn- f28-panel-id');
  const end = src.indexOf('(rum/defcs breadcrumb-with-container <');
  assert.ok(start > 0 && end > start, 'the F28 source-path region was renamed or removed');
  return { all: src, region: src.slice(start, end) };
}

/** The F28 CHILD-CONTEXT feature's own source, from its banner to OG's container. */
function f28CtxSource() {
  const src = fs.readFileSync(
    path.join(REPO, 'src', 'main', 'frontend', 'components', 'block.cljs'), 'utf8');
  const start = src.indexOf('(rum/defc f28-context-line <');
  const end = src.indexOf('(rum/defc ^:large-vars/cleanup-todo block-container-inner');
  assert.ok(start > 0 && end > start, 'the F28 child-context region was renamed or removed');
  return { all: src, region: src.slice(start, end) };
}

/** One top-level form out of the region, by its opening text. */
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

test('a disclosed level is re-resolved by IDENTITY at the moment it is activated', () => {
  const { region } = f28Source();
  const open = form(region, 'open-step! (fn [e]');

  // Exactly one lookup, and it is a lookup ref on `:block/uuid`. Two call sites
  // would mean two chances for one of them to resolve by something else.
  assert.strictEqual((region.match(/db\/entity/g) || []).length, 1,
    'the feature must contain exactly one entity lookup');
  assert.match(open, /db\/entity repo \[:block\/uuid captured\]/,
    'the destination must be re-resolved by the identity the step carries');
  assert.match(open, /f28\/step-identity e/,
    'the identity must come from the step, through the pure accessor');
  assert.match(open, /f28\/navigation captured lookup/,
    'the decision must be the pure one, not an inline cond');

  // The lookup happens INSIDE the activation, not once when the panel rendered.
  assert.ok(!/db\/entity/.test(form(region, '(rum/defc f28-source-path-panel')),
    'the panel must not resolve destinations while rendering');
});

test('nothing about a destination is decided from what a level SAYS', () => {
  const { region } = f28Source();
  const open = form(region, 'open-step! (fn [e]');
  for (const forbidden of ['block/content', 'block-label', 'preview-label',
                           'f27-display-content', 'step-prefix', 'block/name',
                           'block/original-name', 'label']) {
    assert.ok(!open.includes(forbidden),
      `the activation reads ${forbidden}; a destination must come from identity alone`);
  }
});

test('a refusal navigates nowhere, and creates nothing', () => {
  const { region } = f28Source();
  const open = form(region, 'open-step! (fn [e]');

  // One navigation, in the branch that has a proved destination.
  assert.strictEqual((region.match(/route-handler\/redirect-to-page!/g) || []).length, 1,
    'the feature must navigate from exactly one place');
  assert.match(open, /if-let \[target \(f28\/opened decision\)\]/,
    'navigation must be guarded by the pure decision');
  assert.match(open, /route-handler\/redirect-to-page! target/,
    'the destination must be the identity the decision proved, never a name');
  assert.match(open, /reset! \*refusal \{:uuid captured\s*\n?\s*:reason \(f28\/refused decision\)\}/,
    'a refusal must be recorded by the identity that refused, never by position');

  // Nothing in this feature may write, create or transact — the same boundary
  // the first slice declared, now that a control can act.
  for (const forbidden of ['page-handler', 'editor-handler', 'outliner',
                           'transact!', 'save-block', 'create!', 'set-block-property']) {
    assert.ok(!region.includes(forbidden),
      `the F28 feature must not reach ${forbidden}`);
  }
});

test('a level with no stable identity is not offered as a destination at all', () => {
  const { region } = f28Source();
  const panel = form(region, '(rum/defc f28-source-path-panel');
  assert.match(panel, /\(when \(f28\/navigable-step\? e\)/,
    'the control must exist only where an identity does');
  const step = form(region, '(rum/defc f28-path-step');
  assert.match(step, /\(if on-open/, 'the step must fall back to a plain label');
  assert.match(step, /f28-path-step-inert/, 'the inert form must still exist');
});

test('collapsing from inside the path returns focus to THAT group\'s own control', () => {
  const { region } = f28Source();
  const wrapper = form(region, '(rum/defcs f28-source-path <');
  assert.match(wrapper, /toggle-id \(str panel-id "-toggle"\)/,
    "the control's id must be derived from this group's own panel id");
  assert.match(wrapper, /:on-hide \(fn \[\][\s\S]{0,120}?focus-toggle!\)/,
    'hiding from inside the panel must return focus to the control');
  assert.match(wrapper, /gdom\/getElement toggle-id/,
    'focus must be returned by id, so it can only reach this group');
  // Two panels open at once must not share state: both atoms are this
  // component's own locals, and the refusal travels down as a value.
  assert.match(wrapper, /\(rum\/local nil ::press\) \(rum\/local nil ::refusal\)/,
    'both pieces of per-group state must be component locals');
});

test('a fresh disclosure clears a refusal; reading further up does NOT', () => {
  // Corrected 2026-09-09. Continuing a path is not a fresh disclosure: the
  // steps already on screen stay on screen, the refused one among them, so
  // withdrawing the explanation there takes it away for a reason the reader
  // never gave. Opening and collapsing ARE fresh disclosures, and clear it.
  const { region } = f28Source();
  const wrapper = form(region, '(rum/defcs f28-source-path <');
  for (const re of [/:on-hide \(fn \[\] \(reset! \*refusal nil\)/,
                    /f27-btn #\(do \(reset! \*refusal nil\)/]) {
    assert.match(wrapper, re, `a stale refusal survives: ${re}`);
  }
  assert.match(wrapper, /:on-more \(fn \[n\] \(reset! \*press n\)\)/,
    'reading further up must not withdraw the explanation');
  assert.ok(!/:on-more \(fn \[n\] \(reset! \*refusal nil\)/.test(wrapper),
    'the withdrawn clear-on-continue must not come back');
  // And a successful navigation clears it, because the reader got what they
  // asked for.
  const open = form(region, 'open-step! (fn [e]');
  assert.match(open, /\(do \(reset! \*refusal nil\)/,
    'a successful open must clear the previous refusal');
});

test('a matching identity is not accepted as a readable block', () => {
  // The supervisor finding: `{:block/uuid captured :db/id 123}` reached :open.
  const pure = fs.readFileSync(
    path.join(REPO, 'src', 'main', 'frontend', 'util', 'f28_refpath.cljs'), 'utf8');
  const nav = form(pure, '(defn navigation');
  assert.match(nav, /\(not \(readable-block\? fresh\)\)\s+\{:action :refuse :reason :placeholder\}/,
    'navigation must refuse an entity that is not a readable block');
  // Order matters: the more specific refusals must still win.
  const order = [':no-identity', ':unreadable', ':missing', ':mismatch', ':page', ':placeholder']
    .map((r) => nav.indexOf(`:reason ${r}`));
  assert.deepStrictEqual(order.slice().sort((a, b) => a - b), order,
    'the refusals are checked out of order; a placeholder page would report the wrong reason');

  const readable = form(pure, '(defn readable-block?');
  assert.match(readable, /f27o\/readable-target\? e/,
    "F28 must reuse F27's settled readability convention, not restate it");
  assert.match(readable, /string\? \(:block\/content e\)/,
    'the content must be text, not merely present');
  assert.ok(!/some\?/.test(readable),
    'a bare some? is what accepted a placeholder in the first place');
});

test('a redraw cannot take the explanation away with the row', () => {
  const pure = fs.readFileSync(
    path.join(REPO, 'src', 'main', 'frontend', 'util', 'f28_refpath.cljs'), 'utf8');
  const place = form(pure, '(defn refusal-placement');
  assert.match(place, /\{:on-step u\}/);
  assert.match(place, /\{:on-panel true\}/);
  assert.ok(!/step-key|:key/.test(place),
    'placement must be decided by identity, never by a render key');

  const { region } = f28Source();
  const panel = form(region, '(rum/defc f28-source-path-panel');
  assert.match(panel, /placement \(f28\/refusal-placement refusal steps\)/,
    'placement must be decided from the steps this render actually produced');
  assert.match(panel, /\(when \(:on-panel placement\)/,
    'a refusal whose row has gone must still be said, for the panel');
  assert.match(panel, /\(f28\/refusal-on-step\? placement e\)/,
    'a rendered row must ask the placement, not compare keys itself');

  // ONE sentence component, used in both places, so they cannot drift apart.
  assert.strictEqual((region.match(/rum\/defc f28-refusal-line/g) || []).length, 1);
  assert.strictEqual((region.match(/\(f28-refusal-line/g) || []).length, 2,
    'the refusal sentence must be rendered from exactly two call sites');
  const line = form(region, '(rum/defc f28-refusal-line');
  for (const key of [':f28/path-step-gone', ':f28/path-step-unreadable',
                     ':f28/path-step-changed', ':f28/path-step-placeholder',
                     ':f28/path-step-not-openable']) {
    assert.ok(line.includes(key), `the refusal sentence never says ${key}`);
  }
});

test('every refusal reason has a sentence in both languages', () => {
  const pure = fs.readFileSync(
    path.join(REPO, 'src', 'main', 'frontend', 'util', 'f28_refpath.cljs'), 'utf8');
  const listed = form(pure, '(def navigation-refusals');
  const reasons = (listed.match(/:[a-z-]+\]/) ? listed : listed)
    .slice(listed.lastIndexOf('['), listed.lastIndexOf(']') + 1)
    .replace(/[[\]]/g, '').trim().split(/\s+/);
  assert.deepStrictEqual(reasons.slice().sort(),
    [':missing', ':mismatch', ':no-identity', ':page', ':placeholder',
     ':unreadable'].sort());

  const { region } = f28Source();
  const step = form(region, '(rum/defc f28-path-step');
  // Four sentences: `:no-identity` and `:page` share the one that says the step
  // cannot be opened at all, and neither can be reached from a rendered
  // control — the step is not drawn as one.
  const line = form(region, '(rum/defc f28-refusal-line');
  for (const key of [':f28/path-step-gone', ':f28/path-step-unreadable',
                     ':f28/path-step-changed', ':f28/path-step-placeholder',
                     ':f28/path-step-not-openable']) {
    assert.ok(line.includes(key), `the panel never says ${key}`);
  }
  for (const dict of ['en.edn', 'ko.edn']) {
    const body = fs.readFileSync(path.join(REPO, 'src', 'resources', 'dicts', dict), 'utf8');
    for (const key of [':f28/path-open-step', ':f28/path-step-gone',
                       ':f28/path-step-unreadable', ':f28/path-step-changed',
                       ':f28/path-step-placeholder', ':f28/path-step-not-openable']) {
      assert.ok(body.includes(key), `${dict} has no ${key}`);
    }
  }
});

/** One form with its prose removed, so a docstring naming a function is not
 *  mistaken for a call to it. */
function code(text) {
  return text.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/;;[^\n]*/g, '');
}

test('making a level actionable introduces no renderer, no fetch and no macro', () => {
  // Limit L1: a step is plain text. The element changed; what it says did not.
  const { region } = f28Source();
  const step = code(form(region, '(rum/defc f28-path-step'));
  for (const forbidden of ['inline-text', 'map-inline', 'markup-elements-cp',
                           'block-content', 'f27-body-text', '->elem',
                           'dangerouslySetInnerHTML', 'fetch', ':href', 'asset-link',
                           'macro', 'iframe', ':img']) {
    assert.ok(!step.includes(forbidden),
      `a path step reaches ${forbidden}; it must stay a plain bounded label`);
  }
  assert.match(step, /f27c\/preview-label/, 'the same bounded label must still be used');
  // The only elements it may build.
  const tags = [...step.matchAll(/\[:([a-z]+)[.\s\]]/g)].map((m) => m[1]);
  assert.deepStrictEqual([...new Set(tags)].sort(), ['button', 'li', 'span'],
    `a path step builds ${[...new Set(tags)].join(', ')}`);
  // The refusal sentence is its own component now, and it is plain text too.
  const line = code(form(region, '(rum/defc f28-refusal-line'));
  const lineTags = [...line.matchAll(/\[:([a-z]+)[.\s\]]/g)].map((m) => m[1]);
  assert.deepStrictEqual([...new Set(lineTags)].sort(), ['div', 'span'],
    `the refusal sentence builds ${[...new Set(lineTags)].join(', ')}`);
});

test('the panel does not claim a snapshot it does not take', () => {
  // The corrected sentence must not promise that closing and reopening is the
  // only way the content changes, because the walk is in the render body.
  const en = fs.readFileSync(
    path.join(REPO, 'src', 'resources', 'dicts', 'en.edn'), 'utf8');
  const line = en.split('\n').find((l) => l.includes(':f28/path-snapshot'));
  assert.ok(line, 'the sentence is missing');
  assert.match(line, /re-read whenever this result redraws/);
  assert.match(line, /nothing keeps it up to date on its own/);
  assert.ok(!/^.*Read when you opened this/.test(line),
    'the withdrawn snapshot wording must not come back');
  const ko = fs.readFileSync(
    path.join(REPO, 'src', 'resources', 'dicts', 'ko.edn'), 'utf8');
  assert.ok(ko.split('\n').some((l) => l.includes(':f28/path-snapshot') &&
                                        l.includes('다시 그려질 때마다')),
    'the Korean sentence must carry the same correction');
});

test('the F28 renderer really carries this feature and the F27 slices it builds on', () => {
  // Identity checks prove which BUILD this is. This proves what is IN it: the
  // renderer must carry the F28 source-path namespace as well as the F27 work
  // this branch was cut from, so a build made from a stale or wrong checkout
  // fails here rather than in a packaged session.
  const runtime = path.join(STATIC, 'js', 'cljs-runtime');
  assert.ok(fs.existsSync(runtime), 'no compiled renderer in static/js/cljs-runtime');
  const names = fs.readdirSync(runtime);
  for (const ns of ['frontend.util.f28_refpath.js',
                    'frontend.util.f27_context.js',
                    'frontend.util.f27_inline.js']) {
    assert.ok(names.includes(ns), `the renderer does not carry ${ns}`);
  }
});

// --- the child-context disclosure -------------------------------------------
//
// A second, separate F28 control: where OG's linked-references list has
// collapsed a row and is drawing none of what is under it, this discloses that
// context. The claims below are properties of the SOURCE SHAPE rather than of
// one rendered outcome, which is why they are read out of the source.

test('a CLOSED child-context control performs no descendant walk', () => {
  // The one cost claim that is structural: the panel renders only when the
  // control has been opened, so a closed control never reaches `build-plan`.
  const { region } = f28CtxSource();

  const wrapper = form(region, '(rum/defcs f28-child-context <');
  assert.match(wrapper, /\(when desc\s*\n?\s*\(f28-context-panel/,
    'the panel must be rendered only when the control has been opened');
  // The namespaced CALL, not the bare words: the wrapper's own docstring names
  // `build-plan` in order to say that it never reaches it.
  assert.ok(!wrapper.includes('f27ch/build-plan'),
    'the control, which renders for every withheld row, must never walk itself');

  // And the walk must live in exactly one place, so "closed costs nothing"
  // cannot be quietly undone by a second call site.
  assert.strictEqual((region.match(/f27ch\/build-plan/g) || []).length, 1,
    'the child-context feature must contain exactly one descendant walk');
  const panel = form(region, '(rum/defc f28-context-panel');
  assert.strictEqual((panel.match(/f27ch\/build-plan/g) || []).length, 1,
    'and it must be inside the panel');
});

test('the control exists only where OG has stopped, decided from what OG already computed', () => {
  const src = fs.readFileSync(
    path.join(REPO, 'src', 'main', 'frontend', 'components', 'block.cljs'), 'utf8');
  const inner = src.slice(src.indexOf('(rum/defc ^:large-vars/cleanup-todo block-container-inner'),
                          src.indexOf('(defn- attach-order-list-state!'));

  assert.match(inner, /f28ctx\/offer-control\?/,
    'the surface decision must be the pure one, not an inline cond');
  assert.match(inner, /:withheld\?\s*\(f28ctx\/withheld\?\s*\{:collapsed\? collapsed\?/,
    'it must be decided from the collapse state this component already has');
  assert.match(inner, /:has-children\? \(some\? has-child\?\)/,
    'and from the `:block/_parent` check it already performs for `haschild`');

  // No NEW database read is introduced to decide whether the control exists.
  const guard = inner.slice(inner.indexOf('(when (f28ctx/offer-control?'),
                            inner.indexOf('(dnd-separator-wrapper block block-id slide? false false)]))'));
  for (const forbidden of ['db/entity', 'db/pull', 'block/_parent', 'build-plan', 'model/']) {
    assert.ok(!guard.includes(forbidden),
      `deciding whether the control exists reads ${forbidden}; it must cost nothing`);
  }
});

test('the child-context feature reuses the F27 walker and adds no second one', () => {
  const { region } = f28CtxSource();
  assert.match(region, /f27ch\/build-plan/, 'the walk must be f27-children\'s');
  assert.match(region, /\(f27-children-fn repo\)/,
    'and the children-fn must be the one the F27 panels already inject');
  for (const forbidden of ['db/get-block-children', 'db/get-block-immediate-children',
                           'sort-by-left raw', 'loop [', 'blocks->vec-tree']) {
    assert.ok(!region.includes(forbidden),
      `the feature contains ${forbidden}; the walk belongs to f27-children`);
  }
});

test('a disclosed descendant is plain text — no second rich renderer', () => {
  const { region } = f28CtxSource();
  assert.match(region, /f28ctx\/plain-row/,
    'a row\'s label must come from the pure, bounded reducer');
  for (const forbidden of ['f27-body-text', 'inline-text', 'block-content',
                           'block-container', 'markup-element', 'block-reference',
                           'asset-link', 'macro-cp', 'page-cp']) {
    assert.ok(!region.includes(forbidden),
      `the panel renders through ${forbidden}; a disclosed descendant is plain text (M1)`);
  }
});

test('the disclosure is read-only: it navigates nowhere and writes nothing', () => {
  const { region } = f28CtxSource();
  for (const forbidden of ['redirect-to-page!', 'route-handler', 'editor-handler',
                           'toggle-collapsed-block!', 'set-collapsed-block!',
                           'transact!', 'save-block!', 'outliner-core', 'file-handler']) {
    assert.ok(!region.includes(forbidden),
      `the feature reaches ${forbidden}; this disclosure is read-only (M5, B10)`);
  }
});

test("OG's own collapse is left exactly as the reader set it", () => {
  // The panel discloses BESIDE the collapse rather than undoing it, so the fold
  // control still does what it did and closing the panel returns the row to
  // precisely what OG rendered.
  const { region } = f28CtxSource();
  assert.ok(!region.includes('state/toggle-collapsed-block!'));
  assert.ok(!region.includes('state/set-collapsed-block!'));
  assert.ok(!region.includes('expand-block!') && !region.includes('collapse-block!'));
});

test('every control in the panel is a real button, reachable and announced', () => {
  const { region } = f28CtxSource();
  const buttons = (region.match(/:button\./g) || []).length;
  assert.ok(buttons >= 3, `only ${buttons} buttons; the control, the row toggles and the more/hide`);
  assert.strictEqual((region.match(/\[:a\./g) || []).length, 0,
    'an anchor without an href cannot take focus; every control must be a button');
  assert.strictEqual((region.match(/f27-btn /g) || []).length, buttons,
    'every button must go through the shared f27-btn props, which restore Enter and Space');
  assert.match(region, /:aria-expanded \(if desc "true" "false"\)/);
  assert.match(region, /:aria-controls panel-id/);
});

test('collapsing from inside the panel returns focus to THIS row\'s own control', () => {
  const { region } = f28CtxSource();
  const wrapper = form(region, '(rum/defcs f28-child-context <');
  assert.match(wrapper, /toggle-id \(f28ctx\/toggle-id panel-id\)/,
    'the control id must be derived from this row\'s panel id');
  assert.match(wrapper, /panel-id \(f28ctx\/panel-id \(:id config\) uuid' \(::uid state\)\)/,
    'and the panel id from the list, this row\'s block AND this occurrence');
  // Twice: synchronously, and after the re-render in case React replaced the node.
  assert.strictEqual((wrapper.match(/\.focus/g) || []).length, 2,
    'focus must be asserted synchronously and again after the re-render');
  assert.match(wrapper, /js\/setTimeout/);
});

test('a DOM id identifies a mounted OCCURRENCE, not a block in a list', () => {
  // The correction this test exists for. `state/sub-collapsed` is keyed by
  // block uuid alone, and the baseline established that a child which itself
  // names the page is drawn TWICE in one list — once as its own result and
  // once as context under its parent. When such a block is collapsed both
  // appearances are collapsed and both offer this control, so a DOM id built
  // from the list and the block alone was the SAME string for both:
  // `gdom/getElement` could hand a collapse the other appearance's control and
  // `aria-controls` named a panel ambiguously.
  const { region } = f28CtxSource();
  const wrapper = form(region, '(rum/defcs f28-child-context <');

  // The identity is created ONCE, when the instance mounts.
  assert.match(wrapper, /:init \(fn \[state _props\]/,
    'the occurrence identity must be built in :init');
  assert.match(wrapper, /\(assoc state ::uid \(str \(gensym "f28ctx"\)\)\)/,
    'one stable per-mounted-occurrence id, as f27-inline-ref already does');

  // And it must NOT be regenerated per render, which would break aria-controls
  // and focus return rather than fix them.
  const body = wrapper.slice(wrapper.indexOf('[state config block]'));
  for (const forbidden of ['gensym', 'random-uuid', 'rand-int', '(str (random']) {
    assert.ok(!body.includes(forbidden),
      `the render body generates ${forbidden}; the id must be stable across renders`);
  }
  assert.strictEqual((wrapper.match(/\(gensym/g) || []).length, 1,
    'exactly one place may mint this id, and it is :init');

  // Every DOM id the component emits descends from that one identity.
  assert.match(wrapper, /panel-id \(f28ctx\/panel-id \(:id config\) uuid' \(::uid state\)\)/);
  assert.match(wrapper, /toggle-id \(f28ctx\/toggle-id panel-id\)/);

  // The pure helper must actually consume it rather than accept and drop it.
  const util = fs.readFileSync(
    path.join(REPO, 'src', 'main', 'frontend', 'util', 'f28_refctx.cljs'), 'utf8');
  const fn = form(util, '(defn panel-id');
  assert.match(fn, /\[list-id block-id occurrence\]/,
    'panel-id must take the occurrence');
  assert.match(fn, /\(str list-id "-" block-id "-" occurrence\)/,
    'and put it into the id it returns');
  // The CALL forms, not the words: this function's docstring explains why a
  // `gensym` here would be wrong, and prose must not decide a source-shape test.
  assert.ok(!/\(gensym/.test(fn) && !/\(random-uuid/.test(fn),
    'the pure helper must not mint identities of its own');
});

test('each row owns its own state, so two open panels cannot reach each other', () => {
  const { region } = f28CtxSource();
  assert.match(region, /\(rum\/local nil ::desc\)/,
    'the expansion state must be a per-instance local, not a shared atom');
  assert.strictEqual((region.match(/\(rum\/local /g) || []).length, 1,
    'one atom per row: the open flag and the expansion state are the same value');
  assert.ok(!region.includes('defonce') && !region.includes('def *'),
    'nothing about one row may live outside that row');
});

test('the panel says which of three confusable things it is showing', () => {
  const { region } = f28CtxSource();
  assert.match(region, /:f28\/context-of-this-block/,
    'the heading must name what these rows are');
  const en = fs.readFileSync(
    path.join(REPO, 'src', 'resources', 'dicts', 'en.edn'), 'utf8');
  const line = en.split('\n').find((l) => l.includes(':f28/context-of-this-block'));
  assert.ok(line, 'the English heading is missing');
  assert.ok(/reference/i.test(line), 'it must rule out the blocks that reference this one');
  assert.ok(/page/i.test(line), 'and the rest of the page whose list this is');
});

test('every string this feature shows exists in English and in Korean', () => {
  const { region } = f28CtxSource();
  const keys = [...new Set((region.match(/:f28\/context-[a-z-]+/g) || []))];
  assert.ok(keys.length >= 8, `only ${keys.length} strings; the panel says more than that`);
  for (const dict of ['en.edn', 'ko.edn']) {
    const body = fs.readFileSync(
      path.join(REPO, 'src', 'resources', 'dicts', dict), 'utf8');
    for (const k of keys) {
      assert.ok(body.includes(`${k} "`), `${dict} has no ${k}`);
    }
  }
  // And the Korean is really Korean, not the English copied across.
  const ko = fs.readFileSync(
    path.join(REPO, 'src', 'resources', 'dicts', 'ko.edn'), 'utf8');
  for (const k of keys) {
    const line = ko.split('\n').find((l) => l.trim().startsWith(`${k} `));
    assert.match(line, /[가-힣]/, `${k} is not translated`);
  }
});

test('the surface rules are the source-path slice\'s, delegated rather than restated', () => {
  const ctx = fs.readFileSync(
    path.join(REPO, 'src', 'main', 'frontend', 'util', 'f28_refctx.cljs'), 'utf8');
  assert.match(ctx, /f28\/excluded-surface/,
    'the shared exclusions must be delegated to the source-path slice');
  // Its own two questions, and nothing else, are answered here.
  assert.match(ctx, /\(not withheld\?\)\s+:nothing-withheld/);
  assert.match(ctx, /\(not context-list\?\)\s+:not-context-list/);
  for (const restated of [':sidebar ', ':query ', ':preview ', ':embed ',
                          ':whiteboard ', ':html-export ', ':block-refs-list ']) {
    assert.ok(!ctx.includes(restated),
      `f28-refctx restates ${restated.trim()}; it must inherit it and cannot be allowed to drift`);
  }
});

test('the feature is scoped in CSS, so removing it removes its appearance', () => {
  const css = fs.readFileSync(
    path.join(REPO, 'src', 'main', 'frontend', 'components', 'block.css'), 'utf8');
  const at = css.indexOf('F28 child context');
  assert.ok(at > 0, 'the child-context CSS block was renamed or removed');
  // Bounded at the NEXT section banner rather than at the end of the file. It
  // was the last block when this was written; the reference-role slice added
  // one after it, and an unbounded slice would have made this test read that
  // feature's selectors as this one's. The assertion itself is unchanged: every
  // selector in the child-context section is still required to be `f28-ctx`.
  const next = css.indexOf('/* ---', at);
  const block = next > at ? css.slice(at, next) : css.slice(at);
  const selectors = [...block.matchAll(/^\.([a-z0-9-]+)/gm)].map((m) => m[1]);
  assert.ok(selectors.length > 5, 'too few rules to be this feature\'s appearance');
  for (const s of selectors) {
    assert.ok(s.startsWith('f28-ctx'),
      `${s} is not scoped to this feature; removing it would change OG's own styling`);
  }
});

test('the F28 renderer carries the child-context namespace too', () => {
  const runtime = path.join(STATIC, 'js', 'cljs-runtime');
  assert.ok(fs.existsSync(runtime), 'no compiled renderer in static/js/cljs-runtime');
  const names = fs.readdirSync(runtime);
  for (const ns of ['frontend.util.f28_refctx.js', 'frontend.util.f27_children.js']) {
    assert.ok(names.includes(ns), `the renderer does not carry ${ns}`);
  }
});
