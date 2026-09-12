'use strict';

const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createState } = require('./core');
const { executePlan } = require('./executor');
const { planReconciliation, snapshotFingerprint } = require('./planner');
const { stableStringify } = require('./core');
const { APPROVED_TEST_ROOT } = require('./persistence');

function materialize(state) {
  if (state.conflicts.some((conflict) => conflict.status === 'open')) throw new Error('unresolved branches refused');
  const files = [];
  for (const file of Object.values(state.files)) {
    if (file.heads.length !== 1) throw new Error('multi-head file refused');
    const revision = state.revisions[file.heads[0]];
    if (!revision.deleted) files.push({ path: revision.path, content: revision.content });
  }
  return files.sort((a, b) => Buffer.from(a.path).compare(Buffer.from(b.path)));
}

function encodeProtocol(request) {
  const hex = (value) => Buffer.from(value, 'utf8').toString('hex');
  const operations = request.operationIds || [];
  const files = request.files || [];
  const lines = [
    'MAGIC\tF28FS1', `COMMAND\t${request.command}`, `ROOTHEX\t${hex(request.root)}`,
    `RUN\t${request.runName}`, `CASE\t${request.caseName}`, `OWNER\t${request.ownerToken}`,
    `BASIS\t${request.basisFingerprint || request.projectedFingerprint}`,
    `SELECTED\t${request.selectedGeneration || 'none'}`,
    `PROJECTED\t${request.projectedFingerprint}`, `PLAN\t${request.planId || 'none'}`,
    `TX\t${request.transactionId || 'none'}`, `FAILURE\t${request.failurePoint || 'none'}`,
    `OPCOUNT\t${operations.length}`, ...operations.map((id) => `OPHEX\t${hex(id)}`),
    `FILECOUNT\t${files.length}`,
    ...files.flatMap((file) => [`PATHHEX\t${hex(file.path)}`, `CONTENTHEX\t${hex(file.content)}`]),
    `STATEHEX\t${hex(request.state)}`, 'END\t1', '',
  ];
  return lines.join('\n');
}

function invoke(helper, request) {
  const result = spawnSync(helper, [], {
    input: encodeProtocol(request), encoding: 'utf8', timeout: 5000, maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error) throw new Error(`helper execution failed: ${result.error.message}`);
  if (result.status !== 0) {
    const error = new Error((result.stderr || 'helper refused').trim());
    error.exitCode = result.status;
    throw error;
  }
  const output = Object.fromEntries(result.stdout.trim().split('\n').map((line) => {
    const split = line.indexOf(' ');
    if (split < 1) throw new Error('malformed helper response');
    return [line.slice(0, split).toLowerCase(), line.slice(split + 1)];
  }));
  if (!output.status) throw new Error('helper response lacks status');
  return output;
}

function decodeHex(value, label, maximumBytes) {
  if (typeof value !== 'string' || value.length % 2 !== 0
      || value.length > maximumBytes * 2 || !/^[0-9a-f]*$/.test(value)) {
    throw new Error(`malformed ${label}`);
  }
  const bytes = Buffer.from(value, 'hex');
  const decoded = bytes.toString('utf8');
  if (!Buffer.from(decoded, 'utf8').equals(bytes) || decoded.includes('\0')) {
    throw new Error(`malformed ${label} UTF-8`);
  }
  return decoded;
}

function parseReadResponse(stdout) {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > 20 * 1024 * 1024) {
    throw new Error('read response exceeds bound');
  }
  const lines = stdout.split('\n');
  if (lines.pop() !== '' || lines.length < 5) throw new Error('truncated read response');
  let index = 0;
  const take = (prefix) => {
    const value = lines[index++];
    if (typeof value !== 'string' || !value.startsWith(`${prefix} `)) {
      throw new Error(`malformed read response: expected ${prefix}`);
    }
    return value.slice(prefix.length + 1);
  };
  if (take('SCHEMA') !== 'F28READ1') throw new Error('unsupported read response schema');
  const generation = take('GENERATION');
  if (!/^[0-9a-f]{64}$/.test(generation)) throw new Error('malformed generation identity');
  const stateText = decodeHex(take('STATEHEX'), 'state', 8 * 1024 * 1024);
  const countText = take('FILECOUNT');
  if (!/^(0|[1-9][0-9]{0,2})$/.test(countText)) throw new Error('malformed file count');
  const fileCount = Number(countText);
  if (fileCount > 128) throw new Error('file count exceeds bound');
  const files = [];
  let payload = Buffer.byteLength(stateText);
  for (let i = 0; i < fileCount; i += 1) {
    const path = decodeHex(take('PATHHEX'), 'path', 1024);
    const content = decodeHex(take('CONTENTHEX'), 'content', 1024 * 1024);
    payload += Buffer.byteLength(path) + Buffer.byteLength(content);
    if (payload > 8 * 1024 * 1024) throw new Error('read payload exceeds bound');
    files.push({ path, content });
  }
  if (take('END') !== '1' || index !== lines.length) throw new Error('trailing read response data');
  let state;
  try { state = JSON.parse(stateText); } catch (_error) { throw new Error('malformed state JSON'); }
  const expectedFiles = materialize(state);
  if (stableStringify(files) !== stableStringify(expectedFiles)) {
    throw new Error('read response state/files mismatch');
  }
  return {
    schema: 'f28-selected-snapshot/1',
    generation,
    snapshotFingerprint: snapshotFingerprint(state),
    state,
    files,
  };
}

function readSelected({ helper, runName, caseName, ownerToken }) {
  const placeholder = createState('read-selected-protocol');
  const request = {
    command: 'read-selected', root: APPROVED_TEST_ROOT, runName, caseName, ownerToken,
    state: stableStringify(placeholder), projectedFingerprint: snapshotFingerprint(placeholder),
  };
  const result = spawnSync(helper, [], {
    input: encodeProtocol(request), encoding: 'utf8', timeout: 5000, maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error) throw new Error(`read helper execution failed: ${result.error.message}`);
  if (result.status !== 0) {
    const error = new Error((result.stderr || 'read helper refused').trim());
    error.exitCode = result.status;
    throw error;
  }
  return parseReadResponse(result.stdout);
}

function initialize({ helper, runName, caseName, ownerToken, state }) {
  return invoke(helper, { command: 'initialize', root: APPROVED_TEST_ROOT, runName, caseName, ownerToken,
    state: stableStringify(state), projectedFingerprint: snapshotFingerprint(state) });
}

function prepareBatch({ runName, caseName, ownerToken, sourceSnapshot, events, failurePoint }) {
  const plan = planReconciliation(sourceSnapshot, events);
  const executed = executePlan({ sourceSnapshot, events, plan, destinationSnapshot: sourceSnapshot });
  if (executed.status !== 'applied') throw new Error(`batch refused: ${executed.result.code}`);
  const transactionId = crypto.createHash('sha256').update(`${plan.planId}\0${plan.projectedSnapshotFingerprint}`).digest('hex');
  const request = { command:'apply', root:APPROVED_TEST_ROOT, runName, caseName, ownerToken,
    basisFingerprint:plan.basis.snapshotFingerprint, projectedFingerprint:plan.projectedSnapshotFingerprint,
    planId:plan.planId, transactionId, operationIds:plan.actions.map((a)=>a.operation.operationId),
    state:stableStringify(executed.state), files:materialize(executed.state) };
  if (failurePoint) request.failurePoint = failurePoint;
  return { state:executed.state, plan, request };
}

function applyBatch({ helper, ...options }) {
  const prepared = prepareBatch(options);
  return { ...prepared, response: invoke(helper, prepared.request) };
}

module.exports = {
  applyBatch, encodeProtocol, initialize, invoke, materialize, parseReadResponse,
  prepareBatch, readSelected,
};
