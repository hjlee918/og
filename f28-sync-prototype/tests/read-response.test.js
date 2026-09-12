'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createState, stableStringify } = require('../src/core');
const { materialize, parseReadResponse } = require('../src/filesystem-coordinator');

function response(state = createState('read-response')) {
  const hex = (value) => Buffer.from(value, 'utf8').toString('hex');
  const files = materialize(state);
  return [
    'SCHEMA F28READ1', `GENERATION ${'a'.repeat(64)}`, `STATEHEX ${hex(stableStringify(state))}`,
    `FILECOUNT ${files.length}`,
    ...files.flatMap((file) => [`PATHHEX ${hex(file.path)}`, `CONTENTHEX ${hex(file.content)}`]),
    'END 1', '',
  ].join('\n');
}

test('strict reader accepts a complete bounded versioned response', () => {
  const parsed = parseReadResponse(response());
  assert.equal(parsed.schema, 'f28-selected-snapshot/1');
  assert.equal(parsed.files.length, 0);
});

test('strict reader rejects truncation, malformed hex and trailing fields', () => {
  const valid = response();
  assert.throws(() => parseReadResponse(valid.slice(0, -7)), /truncated|expected END/);
  assert.throws(() => parseReadResponse(valid.replace(/STATEHEX [0-9a-f]+/, 'STATEHEX zz')), /malformed state/);
  assert.throws(() => parseReadResponse(valid.replace('END 1\n', 'END 1\nEXTRA no\n')), /trailing/);
});

test('strict reader rejects state/file disagreement and oversized declarations', () => {
  const valid = response();
  assert.throws(() => parseReadResponse(valid.replace('FILECOUNT 0', 'FILECOUNT 129')), /exceeds bound/);
  assert.throws(() => parseReadResponse(valid.replace('FILECOUNT 0', 'FILECOUNT 1')
    .replace('END 1', 'PATHHEX 612e6d64\nCONTENTHEX 78\nEND 1')), /state\/files mismatch/);
});
