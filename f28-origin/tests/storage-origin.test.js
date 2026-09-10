"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../checks/storage-origin');
test('unknown storage and search preferences are preserved, not guessed rebuildable', () => {
  const result = S.classify(['search.theme', 'ls-cache-preference', 'datascript-setting', 'ui/theme', 'logseq-db/synthetic']);
  assert.deepEqual(result.rebuildable, ['logseq-db/synthetic']);
  assert.deepEqual(result.mustCarry, ['search.theme', 'ls-cache-preference', 'datascript-setting', 'ui/theme']);
});
