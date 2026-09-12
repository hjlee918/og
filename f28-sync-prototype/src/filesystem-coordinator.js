'use strict';

const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
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
  const result = spawnSync(helper, [], { input: encodeProtocol(request), encoding: 'utf8' });
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

function initialize({ helper, runName, caseName, ownerToken, state }) {
  return invoke(helper, { command: 'initialize', root: APPROVED_TEST_ROOT, runName, caseName, ownerToken,
    state: stableStringify(state), projectedFingerprint: snapshotFingerprint(state) });
}

function applyBatch({ helper, runName, caseName, ownerToken, sourceSnapshot, events, failurePoint }) {
  const plan = planReconciliation(sourceSnapshot, events);
  const executed = executePlan({ sourceSnapshot, events, plan, destinationSnapshot: sourceSnapshot });
  if (executed.status !== 'applied') throw new Error(`batch refused: ${executed.result.code}`);
  const transactionId = crypto.createHash('sha256').update(`${plan.planId}\0${plan.projectedSnapshotFingerprint}`).digest('hex');
  const request = { command:'apply', root:APPROVED_TEST_ROOT, runName, caseName, ownerToken,
    basisFingerprint:plan.basis.snapshotFingerprint, projectedFingerprint:plan.projectedSnapshotFingerprint,
    planId:plan.planId, transactionId, operationIds:plan.actions.map((a)=>a.operation.operationId),
    state:stableStringify(executed.state), files:materialize(executed.state) };
  if (failurePoint) request.failurePoint = failurePoint;
  return { response:invoke(helper,request), state:executed.state, plan, request };
}

module.exports = { applyBatch, encodeProtocol, initialize, invoke, materialize };
