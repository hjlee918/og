# Limited local synchronization prototype results

Original prototype: 2026-09-11. Pure planner update: 2026-09-12.

## Scope and outcome

The standalone prototype implements the contract in
[`CONTRACT.md`](./CONTRACT.md) without importing code into OG or changing an app
package. The pure core stores immutable whole-file revisions under synthetic
file IDs that do not depend on paths. It records explicit branches for stale
edits, edit/delete and rename/rename conflicts, preserves tombstones, makes
exact operation retries idempotent, rejects changed operation-ID reuse, restores
old content as a new revision, and reports NFC/NFD-normalized path collisions
without renaming or merging either file.

The original filesystem adapter had a containment defect: its fixed pending
path was checked during construction, then later opened with a mode that could
follow a substituted symlink and truncate its target. It also did not
re-establish the cached store/run directory identities at persistence entry
points. The original path-helper test did not exercise that behavior.

The correction pins device/inode identities for the approved root, run and
store; verifies them throughout initialize, read, commit and rename; reads state
with `O_NOFOLLOW`; creates unpredictable pending files exclusively with
`O_CREAT | O_EXCL | O_NOFOLLOW`; and verifies the installed inode after rename
before directory sync and acknowledgement. It preserves unexpected pending
entries instead of truncating or deleting them. Generated state remains in its
fresh test-owned run outside Git; no graph content or runtime state is committed.

## Tests

- Corrected pure state transitions: 7/7 passed.
- Corrected filesystem persistence and containment: 8/8 passed.
- Corrected total focused tests: 15/15 passed.
- Prototype source and corrected persistence-test syntax: 3/3 passed `node --check`.

The previous 11/11 result remains historical evidence for the state behavior
and earlier persistence scenarios. Its earlier filesystem cases passed, but its
path-helper-only containment test did not prove safe real persistence entry
points and is not cited as proof of the corrected containment behavior.

The corrected run covers the original bidirectional state and persistence
scenarios plus actual pending-file symlink substitution, state-file symlink
substitution, store-directory replacement after construction, and preservation
of both pre-existing and interrupted pending files. All attack sentinels are
synthetic files inside the same fresh test run. Initialize, read and commit fail
closed where applicable; sentinel contents remain unchanged. A normal commit,
new store instance and idempotent retry still succeed. The shared approved root
was not enumerated, and prior test runs remain untouched.

Controlled failures occur after temporary-file sync but before rename, and
after durable rename but before acknowledgement. The first remains uncommitted;
the second is found after restart and its retry adds no duplicate revision.

## Limits and next proposal

The failure injection proves this implementation's control-flow ordering under
in-process exceptions. It does not prove sudden-power-loss or hardware
durability. The identity checks and non-following leaf opens block the tested
non-concurrent substitutions. Because Node's path APIs do not provide anchored
directory-relative rename here, the prototype does not claim to eliminate races
against a hostile process swapping directories between checks. It is not an OS
sandbox. The relay remains a local simulator, not encrypted or secure. There is
no network, account, attachment streaming, block identity, parser-aware merge,
mobile adapter, OG watcher integration, existing-graph enrollment or UI. The
prototype does not assign IDs to existing notes or rewrite graph formats.

At the persistence-correction checkpoint, the pure reconciliation planner was
the next proposed batch and had not begun. The following section records its
later approved implementation. Neither checkpoint establishes MVP-A or MVP-B
completion.

## Pure reconciliation planner slice

The standalone [`planner.js`](./src/planner.js) now translates ordered,
explicit synthetic create/update/rename/delete events into a deterministic
in-memory plan. Its operation ID is a stable hash of the graph and event IDs;
the caller still supplies file, revision and parent IDs. Each action reports
the expected current heads and prior content/path/deleted state. Actions,
conflicts, exact duplicates and invalid events are separate outputs. A complete
source-snapshot fingerprint supplies a pure stale-plan precondition.

The planner advances only applicable actions in its projected state. A current
multi-head file, any relevant open file/path conflict, or a conflict introduced
by the operation blocks the event. This remains true for update, rename and
delete even when the core operation result by itself would be `committed`.
Inputs are JSON-cloned and remain unchanged. The module has no filesystem,
watcher, network, account, application or persistence dependency.

Focused in-memory verification:

- First planner run: 8/9 passed. The failure exposed a return-field typo in the
  unchanged-snapshot precondition response; the stale-snapshot rejection path
  already behaved correctly. The failure is retained here rather than hidden.
- Corrected planner tests: 10/10 passed.
- Existing pure transition tests run with the planner: 7/7 passed.
- Final combined in-memory result: 17/17 passed.
- Source/test syntax checks: 3/3 passed.
- Filesystem persistence tests were not rerun because persistence did not
  change. The controlled-prototype 15/15 result above remains historical.

The plan is advisory and reserves nothing. Its fingerprint check can detect a
changed supplied snapshot, but an executor must repeat the precondition at its
own application boundary. It does not read files, discover events, infer
rename/delete/identity, resolve conflicts, merge text or write a graph.

## In-memory plan executor slice

Supervisor independently reran and accepted the preceding core/planner scope at
17/17. The new [`executor.js`](./src/executor.js) completes the in-memory path
from synthetic events through planning, integrity validation and private state
application. It recomputes the plan from the original snapshot/events, rejects
unexpected schema, altered actions or ordering, and mismatched projected-state
fingerprints. It rejects the entire batch if any conflict or invalid event is
present.

Immediately before execution, the executor validates and fingerprints a fresh
destination clone. A basis match may execute, an exact projected-state match is
an already-applied retry, and every other destination is stale. Eligible actions
apply to a private clone in order; the result is returned only when its final
fingerprint matches the plan. Controlled failure after an early private action
returns `state: null`. Existing unrelated conflict branches and history remain
unchanged.

Focused in-memory verification:

- Executor tests: 12/12 passed.
- Existing planner tests: 10/10 passed.
- Existing core tests: 7/7 passed.
- Final combined in-memory result: 29/29 passed.
- New executor source/test syntax checks: 2/2 passed.
- Persistence tests were not rerun because persistence did not change.

The executor is synchronous and in memory. Its private-return behavior is not a
durable transaction, filesystem atomicity guarantee or multi-process lock, and
it does not solve the anchored-directory problem or the documented persistence
races and power-loss limits. It has no filesystem, OG, watcher, network,
account, profile or service integration.

The smallest recommended next step is a separate design review of a
platform-specific anchored directory-handle and atomic compare/apply boundary.
No filesystem executor or application integration was started.
