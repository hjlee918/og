'use strict';

const crypto = require('node:crypto');
const { stableStringify } = require('./core');
const { executePlan } = require('./executor');
const {
  invoke, materialize, readSelected,
} = require('./filesystem-coordinator');
const { snapshotFingerprint } = require('./planner');
const { compareSnapshots } = require('./snapshot-comparison');
const { APPROVED_TEST_ROOT } = require('./persistence');

const PREVIEW_SCHEMA = 'f28-compare-preview/1';
const APPLY_REQUEST_SCHEMA = 'f28-preview-apply-request/1';
const WORKFLOW_RESULT_SCHEMA = 'f28-compare-workflow-result/1';
const issuedPreviews = new WeakMap();

function cloneJson(value, label) {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('undefined');
    return JSON.parse(encoded);
  } catch (_error) {
    throw new Error(`${label} must be JSON serializable`);
  }
}

function digest(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function fingerprint(value) {
  return `sha256:${digest(stableStringify(value))}`;
}

function previewStatus(comparison) {
  if (!comparison.eligibility || comparison.eligibility.eligible !== true || comparison.plan === null) {
    return 'rejected';
  }
  return comparison.plan.actions.length === 0 ? 'no-op' : 'ready';
}

function assemblePreview(location, selected, target) {
  const comparison = compareSnapshots(selected, target);
  const body = {
    schema: PREVIEW_SCHEMA,
    location: cloneJson(location, 'preview location'),
    selected: cloneJson(selected, 'selected snapshot'),
    target: cloneJson(target, 'target snapshot'),
    comparison,
    status: previewStatus(comparison),
  };
  return { ...body, previewId: `preview-${digest(stableStringify(body))}` };
}

function previewComparison({ helper, runName, caseName, ownerToken, targetSnapshot }) {
  const selected = readSelected({ helper, runName, caseName, ownerToken });
  const preview = assemblePreview({ runName, caseName }, selected, targetSnapshot);
  issuedPreviews.set(preview, stableStringify(preview));
  return preview;
}

function validatePreview(inputPreview) {
  let currentEncoding;
  try { currentEncoding = stableStringify(inputPreview); } catch (_error) {
    throw new Error('preview is not canonical JSON data');
  }
  if (!inputPreview || typeof inputPreview !== 'object'
      || issuedPreviews.get(inputPreview) !== currentEncoding) {
    throw new Error('preview was not issued unchanged by this in-memory workflow');
  }
  const preview = cloneJson(inputPreview, 'preview');
  if (!preview || preview.schema !== PREVIEW_SCHEMA || !preview.location
      || typeof preview.location.runName !== 'string'
      || typeof preview.location.caseName !== 'string') {
    throw new Error('preview schema or location is invalid');
  }
  const expected = assemblePreview(preview.location, preview.selected, preview.target);
  if (stableStringify(preview) !== stableStringify(expected)) {
    throw new Error('preview integrity validation failed');
  }
  return preview;
}

function createApplyRequest(inputPreview) {
  const preview = cloneJson(inputPreview, 'preview');
  return {
    schema: APPLY_REQUEST_SCHEMA,
    intent: 'apply-exact-preview',
    previewId: preview.previewId,
    location: cloneJson(preview.location, 'preview location'),
    selectedGeneration: preview.selected && preview.selected.generation,
    sourceSnapshotFingerprint: preview.selected && preview.selected.snapshotFingerprint,
    targetFingerprint: fingerprint(preview.target),
    planFingerprint: preview.comparison && preview.comparison.plan
      ? fingerprint(preview.comparison.plan) : null,
  };
}

function rejected(code, reason, details = {}) {
  return {
    status: 'rejected',
    result: { schema: WORKFLOW_RESULT_SCHEMA, code, reason, ...details },
    state: null,
    selected: null,
  };
}

function applyPreview({
  helper, runName, caseName, ownerToken, preview: inputPreview,
  applyRequest: inputApplyRequest, failurePoint,
}) {
  let preview;
  try {
    preview = validatePreview(inputPreview);
  } catch (error) {
    return rejected('preview-integrity-failed', error.message);
  }
  const expectedApplyRequest = createApplyRequest(preview);
  let applyRequest;
  try { applyRequest = cloneJson(inputApplyRequest, 'apply request'); } catch (error) {
    return rejected('apply-request-invalid', error.message);
  }
  if (stableStringify(applyRequest) !== stableStringify(expectedApplyRequest)) {
    return rejected('apply-request-mismatch', 'apply request is not tied to the exact validated preview');
  }
  if (preview.location.runName !== runName || preview.location.caseName !== caseName) {
    return rejected('preview-location-mismatch', 'preview belongs to a different run or case');
  }
  if (preview.status === 'rejected' || !preview.comparison.eligibility.eligible
      || preview.comparison.conflicts.length || preview.comparison.invalid.length
      || preview.comparison.plan === null) {
    return rejected('comparison-not-eligible', 'invalid or conflicting comparison cannot be applied');
  }

  let destination;
  try { destination = readSelected({ helper, runName, caseName, ownerToken }); } catch (error) {
    return rejected('destination-read-refused', error.message);
  }
  if (preview.status === 'no-op') {
    if (destination.generation !== preview.selected.generation
        || destination.snapshotFingerprint !== preview.selected.snapshotFingerprint) {
      return rejected('stale-preview', 'destination changed after no-op preview');
    }
    return {
      status: 'no-op', state: destination.state, selected: destination,
      result: {
        schema: WORKFLOW_RESULT_SCHEMA, code: 'unchanged-target',
        previewId: preview.previewId, generation: destination.generation,
      },
    };
  }

  const execution = executePlan({
    sourceSnapshot: preview.selected.state,
    events: preview.comparison.proposedEvents,
    plan: preview.comparison.plan,
    destinationSnapshot: destination.state,
  });
  if (execution.status === 'rejected') {
    return rejected('stale-preview', 'destination is not the preview basis or exact result', {
      executorCode: execution.result.code,
    });
  }
  const projectedState = execution.state;
  const plan = preview.comparison.plan;
  const transactionId = digest(`${plan.planId}\0${plan.projectedSnapshotFingerprint}\0${preview.selected.generation}`);
  const publisherRequest = {
    command: 'apply', root: APPROVED_TEST_ROOT, runName, caseName, ownerToken,
    basisFingerprint: preview.selected.snapshotFingerprint,
    selectedGeneration: preview.selected.generation,
    projectedFingerprint: plan.projectedSnapshotFingerprint,
    planId: plan.planId,
    transactionId,
    operationIds: plan.actions.map((action) => action.operation.operationId),
    state: stableStringify(projectedState),
    files: materialize(projectedState),
  };
  if (failurePoint) publisherRequest.failurePoint = failurePoint;
  const publication = invoke(helper, publisherRequest);
  const selected = readSelected({ helper, runName, caseName, ownerToken });
  if (selected.generation !== transactionId
      || selected.snapshotFingerprint !== plan.projectedSnapshotFingerprint
      || stableStringify(selected.state) !== stableStringify(projectedState)
      || stableStringify(selected.files) !== stableStringify(publisherRequest.files)) {
    throw new Error('post-publication read-back verification failed');
  }
  return {
    status: publication.status === 'already-applied' ? 'already-applied' : 'applied',
    state: selected.state,
    selected,
    result: {
      schema: WORKFLOW_RESULT_SCHEMA,
      code: publication.status === 'already-applied' ? 'exact-workflow-retry' : 'preview-applied',
      previewId: preview.previewId,
      generation: transactionId,
      actionCount: plan.actions.length,
    },
  };
}

module.exports = {
  APPLY_REQUEST_SCHEMA,
  PREVIEW_SCHEMA,
  WORKFLOW_RESULT_SCHEMA,
  applyPreview,
  createApplyRequest,
  previewComparison,
  validatePreview,
};
