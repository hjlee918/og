'use strict';

const { SyncPrototypeError, applyOperation, stableStringify } = require('./core');
const {
  PLANNER_SCHEMA,
  PlannerError,
  checkPlanPrecondition,
  planReconciliation,
  snapshotFingerprint,
} = require('./planner');

const EXECUTOR_SCHEMA = 'f28-in-memory-execution/1';

function cloneJson(value, label) {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error('not JSON serializable');
    return JSON.parse(serialized);
  } catch (_error) {
    throw new PlannerError('invalid-input', `${label} must be JSON serializable`);
  }
}

function rejection(code, reason, details = {}) {
  return {
    status: 'rejected',
    state: null,
    result: { schema: EXECUTOR_SCHEMA, code, reason, ...details },
  };
}

function executePlan(input, options = {}) {
  let source;
  let events;
  let suppliedPlan;
  let canonicalPlan;
  try {
    if (!input || typeof input !== 'object') {
      return rejection('invalid-execution-input', 'executor input must be an object');
    }
    source = cloneJson(input.sourceSnapshot, 'source snapshot');
    events = cloneJson(input.events, 'events');
    suppliedPlan = cloneJson(input.plan, 'plan');
    canonicalPlan = planReconciliation(source, events);
  } catch (error) {
    return rejection(
      'invalid-execution-input',
      error instanceof Error ? error.message : 'input validation failed',
    );
  }

  if (!suppliedPlan || suppliedPlan.schema !== PLANNER_SCHEMA) {
    return rejection('unexpected-plan-schema', 'supplied plan schema is not supported');
  }
  if (suppliedPlan.projectedSnapshotFingerprint
      !== canonicalPlan.projectedSnapshotFingerprint) {
    return rejection(
      'projected-fingerprint-mismatch',
      'supplied projected-state fingerprint differs from the recomputed plan',
    );
  }
  if (stableStringify(suppliedPlan) !== stableStringify(canonicalPlan)) {
    return rejection(
      'plan-integrity-failed',
      'supplied plan differs from the plan recomputed from its source and events',
    );
  }
  if (canonicalPlan.conflicts.length || canonicalPlan.invalid.length) {
    return rejection(
      'batch-not-eligible',
      'the complete batch contains a conflict or invalid event',
      {
        conflictCount: canonicalPlan.conflicts.length,
        invalidCount: canonicalPlan.invalid.length,
      },
    );
  }
  if (options.failAfterActionCount !== undefined
      && (!Number.isInteger(options.failAfterActionCount)
        || options.failAfterActionCount < 1)) {
    return rejection('invalid-executor-options', 'failAfterActionCount must be a positive integer');
  }

  let destination;
  try {
    // This is deliberately the last input clone and fingerprint before applying.
    destination = cloneJson(input.destinationSnapshot, 'destination snapshot');
  } catch (error) {
    return rejection('invalid-execution-input', error.message);
  }
  let precondition;
  try {
    precondition = checkPlanPrecondition(canonicalPlan, destination);
  } catch (error) {
    return rejection(
      'invalid-execution-input',
      error instanceof Error ? error.message : 'destination validation failed',
    );
  }
  const destinationFingerprint = precondition.actualSnapshotFingerprint;
  if (destinationFingerprint === canonicalPlan.projectedSnapshotFingerprint) {
    return {
      status: 'already-applied',
      state: destination,
      result: {
        schema: EXECUTOR_SCHEMA,
        code: 'exact-batch-retry',
        planId: canonicalPlan.planId,
        appliedActionCount: 0,
        existingActionCount: canonicalPlan.actions.length,
        duplicateEventCount: canonicalPlan.duplicates.length,
        finalSnapshotFingerprint: destinationFingerprint,
      },
    };
  }
  if (!precondition.applicable) {
    return rejection(
      'stale-plan',
      'destination differs from both the plan basis and exact projected result',
      {
        expectedSnapshotFingerprint: canonicalPlan.basis.snapshotFingerprint,
        actualSnapshotFingerprint: destinationFingerprint,
      },
    );
  }

  let working = cloneJson(destination, 'private execution state');
  const appliedOperationIds = [];
  try {
    for (const action of canonicalPlan.actions) {
      const transition = applyOperation(working, action.operation);
      if (!transition.changed || transition.result.status !== 'committed'
          || transition.result.conflictIds.length) {
        return rejection(
          'execution-contract-mismatch',
          'an eligible action did not produce one new conflict-free revision',
        );
      }
      working = transition.state;
      appliedOperationIds.push(action.operation.operationId);
      if (options.failAfterActionCount === appliedOperationIds.length) {
        return rejection(
          'simulated-execution-failure',
          'controlled test failure occurred before the private result was returned',
          { simulatedAfterActionCount: appliedOperationIds.length },
        );
      }
    }
  } catch (error) {
    const code = error instanceof SyncPrototypeError
      ? `execution-${error.code}`
      : 'execution-failed';
    return rejection(code, error instanceof Error ? error.message : 'execution failed');
  }

  const finalFingerprint = snapshotFingerprint(working);
  if (finalFingerprint !== canonicalPlan.projectedSnapshotFingerprint) {
    return rejection(
      'projected-fingerprint-mismatch',
      'private execution result differs from the validated projected state',
    );
  }
  return {
    status: 'applied',
    state: working,
    result: {
      schema: EXECUTOR_SCHEMA,
      code: 'batch-applied-in-memory',
      planId: canonicalPlan.planId,
      appliedActionCount: appliedOperationIds.length,
      duplicateEventCount: canonicalPlan.duplicates.length,
      appliedOperationIds,
      finalSnapshotFingerprint: finalFingerprint,
    },
  };
}

module.exports = {
  EXECUTOR_SCHEMA,
  executePlan,
};
