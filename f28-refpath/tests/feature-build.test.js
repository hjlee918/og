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

function manifest() {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

test('a feature build is present in static/', () => {
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
  const f28Region = src.slice(src.indexOf('(defn- f28-surface'), start);
  assert.strictEqual((f28Region.match(/f27ctx\/load-ancestors/g) || []).length, 1,
    'the F28 feature must contain exactly one ancestor walk, inside the panel');
});

// --- opening a disclosed level ----------------------------------------------
//
// The first slice left every step inert. Now one can be opened, which is the
// half where a wrong answer does real damage: OG's own `redirect-to-page!`
// CREATES a page when it is handed a name that does not resolve (#3511), and a
// path may legitimately contain several levels reading exactly the same words.
// Each rule below is read out of the source, because each is a property of the
// shape rather than of one rendered outcome.

/** The F28 feature's own source, from its first function to OG's container. */
function f28Source() {
  const src = fs.readFileSync(
    path.join(REPO, 'src', 'main', 'frontend', 'components', 'block.cljs'), 'utf8');
  const start = src.indexOf('(defn- f28-surface');
  const end = src.indexOf('(rum/defcs breadcrumb-with-container <');
  assert.ok(start > 0 && end > start, 'the F28 region was renamed or removed');
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
  const open = form(region, '(fn [k e]');

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
  const open = form(region, '(fn [k e]');
  for (const forbidden of ['block/content', 'block-label', 'preview-label',
                           'f27-display-content', 'step-prefix', 'block/name',
                           'block/original-name', 'label']) {
    assert.ok(!open.includes(forbidden),
      `the activation reads ${forbidden}; a destination must come from identity alone`);
  }
});

test('a refusal navigates nowhere, and creates nothing', () => {
  const { region } = f28Source();
  const open = form(region, '(fn [k e]');

  // One navigation, in the branch that has a proved destination.
  assert.strictEqual((region.match(/route-handler\/redirect-to-page!/g) || []).length, 1,
    'the feature must navigate from exactly one place');
  assert.match(open, /if-let \[target \(f28\/opened decision\)\]/,
    'navigation must be guarded by the pure decision');
  assert.match(open, /route-handler\/redirect-to-page! target/,
    'the destination must be the identity the decision proved, never a name');
  assert.match(open, /reset! \*refusal \{:key k :reason \(f28\/refused decision\)\}/,
    'a refusal must be recorded against the step that refused');

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

test('opening and continuing a path clear a refusal the reader has moved past', () => {
  const { region } = f28Source();
  const wrapper = form(region, '(rum/defcs f28-source-path <');
  for (const re of [/:on-more \(fn \[n\] \(reset! \*refusal nil\)/,
                    /:on-hide \(fn \[\] \(reset! \*refusal nil\)/,
                    /f27-btn #\(do \(reset! \*refusal nil\)/]) {
    assert.match(wrapper, re, `a stale refusal survives: ${re}`);
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
    [':missing', ':mismatch', ':no-identity', ':page', ':unreadable'].sort());

  const { region } = f28Source();
  const step = form(region, '(rum/defc f28-path-step');
  // Four sentences: `:no-identity` and `:page` share the one that says the step
  // cannot be opened at all, and neither can be reached from a rendered
  // control — the step is not drawn as one.
  for (const key of [':f28/path-step-gone', ':f28/path-step-unreadable',
                     ':f28/path-step-changed', ':f28/path-step-not-openable']) {
    assert.ok(step.includes(key), `the panel never says ${key}`);
  }
  for (const dict of ['en.edn', 'ko.edn']) {
    const body = fs.readFileSync(path.join(REPO, 'src', 'resources', 'dicts', dict), 'utf8');
    for (const key of [':f28/path-open-step', ':f28/path-step-gone',
                       ':f28/path-step-unreadable', ':f28/path-step-changed',
                       ':f28/path-step-not-openable']) {
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
  assert.deepStrictEqual([...new Set(tags)].sort(), ['button', 'div', 'li', 'span'],
    `a path step builds ${[...new Set(tags)].join(', ')}`);
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
