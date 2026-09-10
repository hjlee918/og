'use strict';
//
// THE PLUGIN-HOST TRANSFORM's own semantics.
//
// The experimental bundle is derived from the committed first-party one by a
// single substitution. The danger is not that it corrupts the bundle — that
// would be loud. The danger is that it silently does NOTHING: a bundle still
// carrying the old condition looks identical from the outside, fails in exactly
// the same way, and the whole experiment would then be measuring today's
// behaviour while reporting the candidate's. So every clause of the refusal is
// asserted here, and the real committed artifact is transformed at the end.
//
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const T = require(path.join(__dirname, '..', 'src', 'lsplugin-transform.js'));
const REPO = path.resolve(__dirname, '..', '..');
const PROD = path.join(REPO, 'resources', 'js', 'lsplugin.core.js');

test('the anchor and the replacement say the same thing the TypeScript says', () => {
  // Property names terser does not mangle, so they must appear literally.
  for (const prop of ['options', 'effect', 'isInstalledInDotRoot', 'dotPluginsRoot']) {
    assert.ok(T.ANCHOR.includes(prop), `anchor should mention ${prop}`);
  }
  assert.ok(T.REPLACEMENT.includes('privilegedPluginResources'),
    'the replacement must consult the new host option');
  assert.ok(T.REPLACEMENT.includes('this._ctx'),
    'the option lives on the core context, not on the plugin');
  // The old behaviour must remain reachable: without the option, an effect
  // plugin still resolves to file://.
  assert.ok(T.REPLACEMENT.includes('!this.options.effect||'),
    'a non-effect plugin must still be rewritten without the option');
});

test('a bundle without the anchor is refused', () => {
  assert.throws(() => T.transform('function nothing(){}'),
    (e) => e instanceof T.TransformRefusal && /exactly once/.test(e.message));
});

test('a bundle with the anchor twice is refused rather than half-transformed', () => {
  assert.throws(() => T.transform(`x;${T.ANCHOR}y;${T.ANCHOR}`),
    (e) => e instanceof T.TransformRefusal && /found 2/.test(e.message));
});

test('an empty bundle is refused', () => {
  assert.throws(() => T.transform(''), T.TransformRefusal);
  assert.throws(() => T.transform(null), T.TransformRefusal);
});

test('an already-transformed bundle is refused, so the step is not applied twice', () => {
  const once = T.transform(`head;${T.ANCHOR};tail`);
  assert.throws(() => T.transform(once),
    (e) => e instanceof T.TransformRefusal && /already carries/.test(e.message));
});

test('nothing but the anchor changes', () => {
  const before = `alpha;${T.ANCHOR};omega`;
  const after = T.transform(before);
  assert.ok(after.startsWith('alpha;'));
  assert.ok(after.endsWith(';omega'));
  assert.strictEqual(after.length - before.length, T.REPLACEMENT.length - T.ANCHOR.length);
  assert.ok(!after.includes(T.ANCHOR));
});

test('the REAL committed first-party bundle transforms exactly once',
  { skip: !fs.existsSync(PROD) ? 'no committed plugin host bundle' : false },
  () => {
    const before = fs.readFileSync(PROD, 'utf8');
    assert.strictEqual(before.split(T.ANCHOR).length - 1, 1,
      'the committed bundle must carry the rewrite condition exactly once');
    const after = T.transform(before);
    assert.ok(after.includes(T.REPLACEMENT));
    assert.notStrictEqual(after, before);
    // and the transform is a pure function of its input: the production file is
    // read, never written, by this module.
    assert.strictEqual(fs.readFileSync(PROD, 'utf8'), before);
  });
