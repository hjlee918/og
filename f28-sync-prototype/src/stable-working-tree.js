'use strict';

const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { stableStringify } = require('./core');
const { executePlan } = require('./executor');
const { applyPreview, createApplyRequest, validatePreview } = require('./compare-workflow');
const { APPROVED_TEST_ROOT } = require('./persistence');

const WORKING_RESULT_SCHEMA = 'f28-stable-working-result/1';

function digest(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function hex(value) {
  return Buffer.from(value, 'utf8').toString('hex');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function encodeWorkingProtocol(request) {
  return [
    'MAGIC\tF28WT1', `COMMAND\t${request.command}`, `ROOTHEX\t${hex(request.root)}`,
    `RUN\t${request.runName}`, `CASE\t${request.caseName}`, `OWNER\t${request.ownerToken}`,
    `WORKDIR\t${request.workingDirectory}`, `METADIR\t${request.metadataDirectory}`,
    `BASISGEN\t${request.basisGeneration}`, `TARGETGEN\t${request.targetGeneration}`,
    `PREVIEW\t${request.previewFingerprint}`, `PLAN\t${request.planId}`,
    `TX\t${request.transactionId}`, `FAILURE\t${request.failurePoint || 'none'}`,
    `OPCOUNT\t${request.operationIds.length}`,
    ...request.operationIds.map((value) => `OPHEX\t${hex(value)}`),
    `ACTIONCOUNT\t${request.actions.length}`,
    ...request.actions.flatMap((action) => [
      `KIND\t${action.kind}`, `FILEIDHEX\t${hex(action.fileId)}`,
      `OLDPATHHEX\t${hex(action.oldPath)}`, `OLDCONTENTHEX\t${hex(action.oldContent)}`,
      `NEWPATHHEX\t${hex(action.newPath)}`, `NEWCONTENTHEX\t${hex(action.newContent)}`,
    ]),
    `BASESTATEHEX\t${hex(request.baseMetadata)}`, `STATEHEX\t${hex(request.projectedMetadata)}`,
    'END\t1', '',
  ].join('\n');
}

function invokeWorking(helper, request, options = {}) {
  const result = spawnSync(helper, [], {
    input: encodeWorkingProtocol(request), encoding: 'utf8',
    timeout: options.timeout || 5000, maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error) throw new Error(`working helper execution failed: ${result.error.message}`);
  if (result.status !== 0) {
    const error = new Error((result.stderr || 'working helper refused').trim());
    error.exitCode = result.status;
    throw error;
  }
  const output = Object.fromEntries(result.stdout.trim().split('\n').map((line) => {
    const separator = line.indexOf(' ');
    if (separator < 1) throw new Error('malformed working helper response');
    return [line.slice(0, separator).toLowerCase(), line.slice(separator + 1)];
  }));
  if (!output.status) throw new Error('working helper response lacks status');
  return output;
}

function currentFiles(state) {
  const files = [];
  for (const [fileId, file] of Object.entries(state.files)) {
    if (file.heads.length !== 1) throw new Error('working initialization refuses multi-head files');
    const revision = state.revisions[file.heads[0]];
    if (!revision.deleted) files.push({
      kind: 'create', fileId, oldPath: '', oldContent: '',
      newPath: revision.path, newContent: revision.content,
    });
  }
  return files.sort((left, right) => Buffer.from(left.fileId).compare(Buffer.from(right.fileId)));
}

function initializeWorkingTree({
  workingHelper, runName, caseName, ownerToken, selected,
  workingDirectory = 'working', metadataDirectory = 'f28-work-meta',
}) {
  const state = stableStringify(selected.state);
  const request = {
    command: 'initialize', root: APPROVED_TEST_ROOT, runName, caseName, ownerToken,
    workingDirectory, metadataDirectory, basisGeneration: selected.generation,
    targetGeneration: selected.generation,
    previewFingerprint: `sha256:${digest(stableStringify(selected))}`,
    planId: 'working-initialize',
    transactionId: digest(`working-init\0${selected.generation}\0${state}`),
    operationIds: [], actions: currentFiles(selected.state),
    baseMetadata: state, projectedMetadata: state,
  };
  return { request, response: invokeWorking(workingHelper, request) };
}

function actionsFromPlan(preview, projectedState) {
  return preview.comparison.plan.actions.map((planned) => {
    const operation = planned.operation;
    const prior = planned.expected.parent;
    const after = projectedState.revisions[operation.revisionId];
    const common = { kind: operation.kind, fileId: operation.fileId };
    if (operation.kind === 'create') return {
      ...common, oldPath: '', oldContent: '', newPath: after.path, newContent: after.content,
    };
    if (!prior) throw new Error('non-create working action lacks expected parent');
    if (operation.kind === 'delete') return {
      ...common, oldPath: prior.path, oldContent: prior.content, newPath: '', newContent: '',
    };
    return {
      ...common, oldPath: prior.path, oldContent: prior.content,
      newPath: after.path, newContent: after.content,
    };
  });
}

function prepareWorkingRequest({
  runName, caseName, ownerToken, preview: inputPreview,
  workingDirectory = 'working', metadataDirectory = 'f28-work-meta', failurePoint,
}) {
  const preview = validatePreview(inputPreview);
  if (preview.status === 'rejected' || !preview.comparison.eligibility.eligible
      || preview.comparison.plan === null) throw new Error('working application requires an eligible preview');
  const execution = executePlan({
    sourceSnapshot: preview.selected.state, events: preview.comparison.proposedEvents,
    plan: preview.comparison.plan, destinationSnapshot: preview.selected.state,
  });
  if (execution.status === 'rejected') throw new Error(`preview execution refused: ${execution.result.code}`);
  const plan = preview.comparison.plan;
  const transactionId = digest(`${plan.planId}\0${plan.projectedSnapshotFingerprint}\0${preview.selected.generation}`);
  return {
    command: 'apply', root: APPROVED_TEST_ROOT, runName, caseName, ownerToken,
    workingDirectory, metadataDirectory, basisGeneration: preview.selected.generation,
    targetGeneration: transactionId,
    previewFingerprint: `sha256:${digest(stableStringify(preview))}`,
    planId: plan.planId, transactionId,
    operationIds: plan.actions.map((action) => action.operation.operationId),
    actions: actionsFromPlan(preview, execution.state),
    baseMetadata: stableStringify(preview.selected.state),
    projectedMetadata: stableStringify(execution.state), failurePoint,
  };
}

function preflightWorkingTree({ workingHelper, request }) {
  return invokeWorking(workingHelper, { ...request, command: 'preflight', failurePoint: 'none' });
}

function applyStablePreview({
  helper, workingHelper, runName, caseName, ownerToken, preview,
  applyRequest = createApplyRequest(preview), failurePoint,
  workingDirectory = 'working', metadataDirectory = 'f28-work-meta',
}) {
  let request;
  try {
    request = prepareWorkingRequest({
      runName, caseName, ownerToken, preview, workingDirectory, metadataDirectory, failurePoint,
    });
    preflightWorkingTree({ workingHelper, request });
  } catch (error) {
    return { status: 'rejected', result: { schema: WORKING_RESULT_SCHEMA,
      code: 'working-preflight-refused', reason: error.message }, state: null };
  }
  const published = applyPreview({ helper, runName, caseName, ownerToken, preview, applyRequest });
  if (published.status === 'rejected') return published;
  if (published.status === 'no-op') return { ...published, working: { status: 'unchanged' } };
  if (!published.selected || published.selected.generation !== request.targetGeneration) {
    return { status: 'rejected', result: { schema: WORKING_RESULT_SCHEMA,
      code: 'published-generation-mismatch', reason: 'publisher selected an unexpected generation' }, state: null };
  }
  try {
    const response = invokeWorking(workingHelper, request);
    return {
      status: response.status === 'already-applied' ? 'already-applied' : 'applied',
      result: { schema: WORKING_RESULT_SCHEMA, code: 'working-tree-acknowledged',
        generation: published.selected.generation, transactionId: request.transactionId },
      state: published.state, selected: published.selected, working: response, request,
    };
  } catch (error) {
    error.published = published;
    error.workingRequest = request;
    throw error;
  }
}

function causeRecords(request) {
  return request.actions.map((action, index) => ({
    operationId: request.operationIds[index], fileId: action.fileId, kind: action.kind,
    oldPath: action.oldPath, newPath: action.newPath,
    oldPresent: Boolean(action.oldPath) && action.kind !== 'create',
    newPresent: Boolean(action.newPath) && action.kind !== 'delete',
    newContentHash: digest(action.newContent),
  }));
}

function classifyWatcherEvents(records, events) {
  const exact = new Set(records.map((record) => stableStringify(record)));
  const echoes = [], edits = [], invalid = [];
  for (const input of events) {
    let event;
    try { event = clone(input); } catch (_error) { invalid.push({ code: 'invalid-event' }); continue; }
    if (exact.has(stableStringify(event))) echoes.push(event);
    else edits.push(event);
  }
  return { schema: 'f28-working-watcher-classification/1', echoes, edits, invalid };
}

module.exports = {
  applyStablePreview, causeRecords, classifyWatcherEvents, encodeWorkingProtocol,
  initializeWorkingTree, invokeWorking, prepareWorkingRequest, preflightWorkingTree,
};
