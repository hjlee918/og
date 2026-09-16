#!/usr/bin/env node
'use strict';

/*
 * Focused headless regressions for the probe's identity binding.
 *
 * No application, no helper, no filesystem: a stubbed page evaluates the probe's
 * own page functions against INJECTED observation records, so the exact filter
 * semantics are pinned. Every record here is injected and is labelled as such;
 * nothing in this file observes real OG behaviour.
 *
 * The defect this pins: `write-file-impl!` passes OG's REPO to `save-pending!`
 * (fs/node.cljs) and `rename-file!` passes it to `rename-intent!`
 * (handler/page.cljs), so a cause's `graph-id` holds the OG repo -- not our
 * sidecar graph id. Filtering by the sidecar id matched nothing and made a busy
 * graph look quiet.
 */

const PROBE = require('./og-idle-probe');
const { makeIdleGate } = require('./app-closed-gate');

let passed = 0;
const check = (id, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}`);
  if (!ok) { console.error(JSON.stringify(detail, null, 2)); throw new Error(id); }
  passed += 1;
};

/* A stub page: runs the probe's evaluate body with a window exposing the
 * injected observation stream. */
function stubPage(events) {
  return {
    evaluate: async (fn, args) => {
      const previous = global.window;
      global.window = { [PROBE.OBSERVATION_API]: { read: () => events } };
      try { return await fn(args); } finally { global.window = previous; }
    },
  };
}

const OG_REPO = 'logseq_local_/Users/x/Logseq Test/run/graph';
const OTHER_REPO = 'logseq_local_/Users/x/Logseq Test/run/other-graph';
const SIDECAR_ID = 'f28-idle-graph-2026-09-16-synthetic';

const cause = (id, kind, status, graphId) => ({
  event: `${kind}-${status}`,
  cause: { 'cause-id': id, kind, status, ...(graphId === undefined ? {} : { 'graph-id': graphId }) },
});

async function main() {
  // ---------------------------------------------- 1. matching repo is counted
  const pendingSave = stubPage([cause('c1', 'save', 'pending', OG_REPO)]);
  let result = await PROBE.pendingLocalCauses(pendingSave, OG_REPO);
  check('matching-repo-pending-save-is-seen',
    result.pending === 1 && result.total === 1 && result.unbound === 0, result);

  // ------------------------------- 2. the sidecar graph id matches NOTHING
  result = await PROBE.pendingLocalCauses(pendingSave, SIDECAR_ID);
  check('the-sidecar-graph-id-matches-no-cause',
    result.pending === 0 && result.total === 0 && result.otherRepoCauses === 1,
    { ...result, note: 'this is the confirmed defect: the sidecar id is not OG state' });

  // --------------------------------------- 3. a different repo is not counted
  result = await PROBE.pendingLocalCauses(pendingSave, OTHER_REPO);
  check('a-different-repo-does-not-see-this-cause',
    result.pending === 0 && result.total === 0 && result.otherRepoCauses === 1, result);

  // ------------------------------------- 4. missing identity is never trusted
  const unboundSave = stubPage([cause('c2', 'save', 'pending', undefined)]);
  result = await PROBE.pendingLocalCauses(unboundSave, OG_REPO);
  check('a-cause-with-no-graph-identity-is-unbound-not-absent',
    result.pending === 0 && result.unbound === 1 && result.unboundPending === 1, result);

  // ------------------------------------------------- 5. a failed save is seen
  const failedSave = stubPage([cause('c3', 'save', 'failed', OG_REPO)]);
  result = await PROBE.pendingLocalCauses(failedSave, OG_REPO);
  check('a-failed-save-is-counted-separately',
    result.failed === 1 && result.pending === 0 && result.total === 1, result);

  // ---------------------------------------------- 6. a pending rename is seen
  const pendingRename = stubPage([cause('c4', 'rename', 'pending', OG_REPO)]);
  result = await PROBE.pendingLocalCauses(pendingRename, OG_REPO);
  check('a-pending-rename-is-counted',
    result.pending === 1 && result.total === 1, result);

  // --------------------- 7. a completed cause is present but not pending/failed
  const completed = stubPage([
    cause('c5', 'save', 'pending', OG_REPO),
    cause('c5', 'save', 'completed', OG_REPO),
  ]);
  result = await PROBE.pendingLocalCauses(completed, OG_REPO);
  check('a-completed-cause-is-not-pending-or-failed',
    result.pending === 0 && result.failed === 0 && result.total === 1, result);

  // ---------------------------------- the repo argument itself is required
  const missingRepo = await PROBE.pendingLocalCauses(pendingSave, null);
  check('an-absent-og-repo-is-refused-not-defaulted',
    missingRepo.error === 'missing-og-repo', missingRepo);

  // ------------------------- the real gate refuses on each of these findings
  const gateFor = (signals) => makeIdleGate(async () => ({
    editing: false, composing: false, inputIdle: true, writesFinished: true,
    pendingCauses: 0, failedCauses: 0, unboundOpenCauses: 0,
    repoMatchesOwnedGraph: true, ...signals,
  }));
  for (const [label, signals, expected] of [
    ['pending-save', { pendingCauses: 1 }, 'pending-bridge-cause'],
    ['failed-save', { failedCauses: 1 }, 'failed-local-save'],
    ['unbound-open-cause', { unboundOpenCauses: 1 }, 'unattributable-open-cause'],
    ['wrong-graph', { repoMatchesOwnedGraph: false }, 'app-on-another-graph'],
    ['unknown-graph', { repoMatchesOwnedGraph: null }, 'owned-graph-binding-unknown'],
    ['unreadable-causes', { pendingCauses: null }, 'pending-causes-unreadable'],
  ]) {
    const verdict = await gateFor(signals)('probe');
    check(`the-real-gate-refuses-on-${label}`,
      verdict.idle === false && verdict.failing.includes(expected)
      && verdict.closed !== true, verdict);
  }

  const clean = await gateFor({})('probe');
  check('the-real-gate-reports-idle-when-every-signal-is-clean',
    clean.idle === true && clean.failing.length === 0 && clean.closed !== true, clean);

  console.log(`\nProbe binding check passed: ${passed} checks (all records INJECTED; no OG behaviour observed)`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
