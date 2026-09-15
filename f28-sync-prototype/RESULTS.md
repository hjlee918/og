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

## Synthetic filesystem application experiment

User approval replaced the blocked Swift helper with a test-only x86_64 C
helper. Before graph-root access, a `/tmp` capability probe compiled and linked
`openat`, `renameat`, `flock`, CommonCrypto SHA-256 and `F_FULLFSYNC`, then ran
successfully. Apple Clang was `16.0.0` (`clang-1600.0.26.6`), targeting
`x86_64-apple-darwin23.6.0`. The final release helper SHA-256 was
`e6b12dbf0169267eb4870179901d8fc1f74d078e092e5f4b7bfcf4365113b7fd` at
test time. The corresponding C source SHA-256 was
`9b4472ace4d09880cb6764e963902064fb0773e268db4bd31b7cc0284ba8106b`.
Binaries stayed in `/tmp` and are not committed.

One exact owned run, `f28-fs-c-20260912-9ee8060b4-a1`, contains all case
directories. The shared root was never listed, no other run was inspected, and
the generated content remains outside Git. Retained non-passing evidence:

- v1: 0/16. Genesis verification exposed a one-byte `FILECOUNT` parser offset;
  no event batch applied.
- v2: 15/16. A projected fingerprint match without matching plan identity was
  incorrectly classified as an exact retry, bypassing the malformed-path probe.
- v3 after both corrections: 16/16.
- Final v7 with bounded-protocol, stable-lock identity and full manifest-agreement
  regressions: 17/17.
- Final AddressSanitizer/UndefinedBehaviorSanitizer run (`asan5`): 17/17.
- Accepted pure core/planner/executor tests: 29/29. Source syntax and strict C
  warning checks passed.

The final cases cover create/update/rename/delete, exact retry, Korean/English
bytes, NFC/NFD collision refusal, traversal/symlink/ownership refusal,
overlapping helper refusal and lock release after owned-process death, stale
basis and changed source, injected failures during staging/preparation/selector
publication/synchronization/before acknowledgement, prepared roll-forward,
published retry recognition, and corrupt/missing selector, manifest, state and
file contents. Prior-generation hashes remained unchanged in the success path;
incomplete and corrupt evidence was retained.

The helper validates filesystem-bearing inputs and performs every graph-root
filesystem operation. Node owns JSON/state semantics and the accepted pure
planner/executor; the C helper verifies the projected state fingerprint and the
manifest/state/materialized byte hashes. These hashes are integrity comparisons,
not authentication. Full-generation copying is a prototype choice.

Selector replacement publishes one complete generation to participating
readers, not an atomic multi-file write. `flock` coordinates only these helpers.
Injected exits and syscall-failure points prove control-flow and recovery paths,
not real power-loss durability. `F_FULLFSYNC` succeeded on the tested host and
run, but other filesystems/platforms remain untested. Concurrent relocation of
an already-open ancestor remains outside this controlled single-writer threat
model. There is no OG integration, existing-graph enrollment, watcher, account,
network, encryption, attachment, mobile or Roam-import work.

The smallest proposed next step is review of a read-only adapter that compares
one fresh synthetic replica snapshot with the selected generation. It should
not write files or connect OG without separate approval.

## Publication and recovery correction

Source review after the original 17/17 checkpoint found three gaps: a retained
pending selector could be renamed without validation, published retry used only
plan/projected substrings, and the final basis check did not reverify selected
state and files. That initial result remains historical and is not evidence for
the corrected paths.

The helper now validates an existing pending selector through an anchored
`O_NOFOLLOW` regular-file open and exact 65-byte comparison before rename. An
already-applied retry must match the complete request-derived manifest and
selected state/files, followed by synchronization and directory/lock identity
checks before output. Immediately before publication it fully verifies the
selected basis generation and root, run, case, metadata, generations and lock
identities. A controlled pause hook permits an outside synthetic test writer to
change basis state or file content between initial and final verification.

All correction evidence lives in the single fresh owned run
`f28-fs-recovery-20260912-9cca9679c-a1`; the shared root and previous runs were
not enumerated or opened. Final release integration tests passed 23/23, final
AddressSanitizer/UndefinedBehaviorSanitizer integration tests passed 23/23, and
the affected pure core/planner/executor tests passed 29/29. Strict C warnings
and source syntax checks passed. The corrected C source SHA-256 was
`20dfdb2314f2f00f561241bc6acf0560146fe1cf637417d4db46a5ff52e9a0f7`;
the tested x86_64 helper SHA-256 was
`88af6443525db64bb8a79b2d155aa79fb281d6a243636557252c20f62c790318`.
The binary remains outside Git.

Focused cases cover wrong-content and symlink pending entries, exact valid
pending recovery, altered retry transaction/files/operation IDs, and selected
state and materialized-source changes during the final-verification pause.
Refusals preserved the previous selector, prior and prepared generation bytes,
and unexpected pending/sentinel evidence. All helper processes exited or were
test-owned processes explicitly terminated and awaited.

These corrections close the reviewed entry paths in the controlled one-writer
experiment. They do not make generation preparation a multi-file atomic write,
make `flock` control unrelated writers, prove power-loss durability, or remove
the documented race after a check and concurrent-ancestor relocation limit.

## Read-only selected-generation comparison slice

The standalone helper now has a non-initializing `read-selected` command. It
opens one explicit existing owned run/case, opens the existing stable lock
without `O_CREAT`, holds a shared cooperative lock, and verifies the selected
state and files before returning a bounded `F28READ1` response. It repeats the
selector/generation and opened-directory/lock identity checks immediately before
the response. The coordinator strictly parses and cross-checks the response and
uses bounded child-process time/output limits.

The new pure comparison adapter uses only caller-supplied synthetic file IDs.
It deterministically reports unchanged/unknown items, eligible create/update/
rename/delete events, conflicts and invalid inputs, and returns the existing
planner output without executing it. Absence is not deletion without an
explicit complete-snapshot authorization or tombstone. Duplicate or ambiguous
IDs, combined rename/content edits, implicit restore and normalized path
collisions are refused.

All native evidence is contained in the single fresh owned run
`f28-read-compare-20260912-fc023e4f-a1`; no shared-root enumeration or prior-run
access occurred. Final verification results:

- Pure core/planner/executor/comparison/response tests: 40/40 passed.
- Focused release `read-selected` integration: 5/5 passed.
- Focused AddressSanitizer/UndefinedBehaviorSanitizer read integration: 5/5
  passed (`ASAN_OPTIONS=detect_leaks=0`).
- Existing affected publication/recovery integration: 23/23 passed once with
  the release helper.
- Strict JavaScript syntax checks and C warning-as-error build passed.

The focused native cases cover verified Korean/English state and file bytes,
missing metadata without initialization, invalid ownership, missing lock
without replacement, and a controlled `CURRENT` change between verification
passes. Directory-entry names/types and file bytes were hashed before and after
each helper read/refusal; access times were not used. Strict parser tests cover
truncated, malformed, oversized and state/file-inconsistent responses. Every
spawned helper exited or was bounded and awaited; no owned helper remains.

Apple Clang remained 16.0.0 (`clang-1600.0.26.6`), targeting
`x86_64-apple-darwin23.6.0`. The tested C source SHA-256 was
`d8349709023585a5082055c17701aa1ec0497b97633e7fa61cda4dfe7d2ebd4a` and the
release helper SHA-256 was
`746d82f82772beaeb6e17d0d5d3b2389b9c7594a9076f6b4a60684f381654240`.
Native binaries and generated state remain outside Git.

This demonstrates a bounded read and advisory comparison for the controlled
synthetic experiment. It does not apply a comparison plan, make read/compare/
apply atomic, control unrelated writers, prove power-loss behavior, enroll an
existing graph or integrate OG. Accounts, networking, encryption, attachments,
mobile adapters and imports remain excluded. The smallest next proposal is a
documentation review for a synthetic compare/apply orchestration boundary;
implementation requires separate approval.

## Snapshot-comparison deletion correction

Supervisor reproduction after the original 40/40 pure checkpoint found that a
complete target containing an invalid entry for an existing file ID could emit
both `invalid-file` and an absence-derived delete for that same ID. The original
result remains historical evidence for its covered cases; it did not establish
safe deletion behavior for invalid or duplicate target entries.

The adapter now records explicitly mentioned valid string IDs independently of
entry usability. Invalid or duplicated mentions therefore cannot become
absence. Any invalid or ambiguous comparison input makes claimed completeness
untrustworthy and suppresses all absence-derived deletes. Valid explicit
tombstones remain distinguishable and continue to propose deletion.

Comparison eligibility is now part of the versioned
`f28-snapshot-comparison/2` result contract. Any comparison
invalidity or conflict returns `comparison-not-eligible` and `plan: null`.
Valid changes may remain in `proposedEvents` for diagnosis, but there is no
executable partial plan; only a wholly eligible result exposes the planner plan.
This preserves the executor's all-or-nothing model without relying on a future
caller to combine unrelated fields correctly.

Focused pure verification, run without graph, profile, application or native
filesystem access, passed 46/46 across core, planner, executor, response parser
and comparison tests. New cases cover invalid content and path for an existing
ID with missing-delete permission, duplicated existing IDs, an unidentified
invalid entry in a supposedly complete target, mixed valid and invalid or
conflicting entries, genuine authorized complete absence, conservative partial
absence, valid explicit tombstones, deterministic results and unchanged inputs.
Native code did not change, so native filesystem tests were not rerun.

## Synthetic compare/preview/apply workflow

The accepted components now complete one standalone path: verified selected
read, comparison schema v2, reviewable preview, explicit in-memory apply request,
planner/executor validation, locked native publication, verified read-back and
deterministic retry/recovery. Preview is the read-only default. Invalid,
conflicting or diagnostic comparisons expose no plan to the workflow publisher.

The apply request binds the exact issued preview, location, target, source
snapshot, selected generation and plan. Altered or copied previews and changed
requests are refused. Immediately before execution the workflow rereads the
destination without rebasing. The helper independently checks the exact
previewed generation under its existing exclusive lock; exact published retry
may instead match the deterministic transaction generation. An unchanged target
rechecks its original selected generation and returns a successful no-op without
publishing.

All filesystem evidence is contained in the single fresh owned run
`f28-compare-workflow-20260912-cc42856e-a1`. The shared root and prior runs were
not enumerated or opened. Final verification:

- Accepted pure core/planner/executor/comparison/response tests: 46/46 passed.
- Focused release end-to-end workflow tests: 7/7 passed.
- AddressSanitizer/UndefinedBehaviorSanitizer workflow tests: 7/7 passed
  (`ASAN_OPTIONS=detect_leaks=0`).
- Affected native publication/recovery regressions: 23/23 passed.
- Affected read-selected regressions: 5/5 passed.
- Strict JavaScript syntax, diff checks and warning-as-error x86_64 C build
  passed.

The cases prove preview entry/file bytes stay unchanged; explicit apply and
read-back match previewed state/files; unchanged targets add no generation;
invalid, duplicate and NFC/NFD-colliding targets cannot reach the writer;
tampered previews/requests are refused; a changed destination is stale; partial
absence preserves files; authorized absence creates a tombstone while retaining
history; Korean/English bytes survive; and interrupted preparation plus exact
retry reuse one generation. A direct regression also proves the helper refuses
a changed preview generation while holding its lock.

Apple Clang remained 16.0.0 (`clang-1600.0.26.6`), targeting
`x86_64-apple-darwin23.6.0`. The tested C source SHA-256 was
`723c36c2fbf35eb2193ac2b04c1d30b387443a1998f551cafd7801f937a76774`; the
release helper SHA-256 was
`5b86c4689de1783a49ce6989bf40d866a086e8f199a3801c839b16fb7b0c5a99`.
Native binaries and generated state remain outside Git. Earlier results remain
historical evidence for their recorded source and do not substitute for these
workflow cases.

The in-memory preview is lost on process restart and is not an account or
durable approval record. The workflow does not make the separate read and apply
one transaction; the helper revalidates at its own locked boundary. Cooperative
locking does not block arbitrary editors, selector publication is not
multi-file atomicity, and controlled failure injection is not a power-loss
test. Existing graph identity enrollment, change discovery, OG/mobile adapters,
networking, accounts, encryption, attachments and imports remain absent.

The next meaningful milestone is a design review for explicit synthetic
identity enrollment and change capture. It should remain separate from OG and
must not infer identities or deletions; it has not begun.

## Pure identity enrollment and change-capture slice

The standalone `identity-capture.js` module now validates complete versioned
identity metadata, enrolls only an explicit caller-supplied synthetic file list,
and initializes a second simulated replica with the same graph/file IDs and
separate local pending state. Every capture rechecks the metadata revision,
accepted selected-snapshot fingerprint, accepted revision, exact path and
content hash. Accepted and proposed metadata are returned separately.

Controlled save, rename, external-change and read observations are combined
deterministically across calls. Save completion and rename intent are
insufficient alone. External unlink/add remain separate until an exact
revision-bound review decision resolves them. Missing, unstable, contradictory,
invalid or unreviewed observations expose no target. Equivalent notifications
are idempotent, while changed observation-ID reuse and multiple incompatible
changes for one file are rejected. Eligible results create a complete synthetic
target and feed it to `compareSnapshots`; they do not call the filesystem
preview, publisher or native helper. Observation evidence for a proposed change
remains in local state because this slice has no apply acknowledgement.

Focused verification used pure in-memory synthetic state only:

- New identity/capture tests: 23/23 passed.
- Existing core/planner/executor/comparison/response regressions plus the new
  tests: 69/69 passed.
- JavaScript syntax checks and `git diff --check` passed.

The first focused run reported 17/21 because two collision tests used paths that
did not match their accepted snapshots and one test expected a thrown stale
review error where the contract returns an ineligible diagnostic. The fixtures
and expectation were corrected; no fail-open behavior was accepted. A later
mixed-batch review also added retention of valid captured evidence when another
item invalidates the all-or-nothing batch.

The tests cover complete enrollment, replica identity carry-over, duplicate IDs
and paths, metadata/snapshot and revision mismatch, save/read ordering across
pending batches, repeated and contradictory observations, failed and completed
rename, external delete-plus-create ambiguity, exact review binding, explicit
create/delete decisions, incomplete reads, NFC/NFD and case collisions,
deterministic output and unchanged inputs.

All evidence is synthetic and in memory. A supplied `stable` flag proves only
the pure classification branch. No graph, sidecar, watcher, profile, application
or filesystem fixture was accessed. Real watcher capture, metadata persistence,
stable working-tree application, sidecar transport, mobile behavior and
cross-device synchronization remain unimplemented. The next meaningful
milestone is a documentation review for the stable working-tree capture/apply
boundary; it must not begin filesystem enrollment or OG integration implicitly.

## Capture-to-comparison revision correction

Supervisor review found that the original eligible capture built proposed
metadata from its preliminary causal-event execution, then exposed a comparison
plan with newly generated revision IDs. Executing that plan therefore produced a
head that `validateMetadata` rejected against the proposed metadata. The prior
69/69 result remains valid component-test evidence, but it did not exercise this
metadata handoff.

The comparison plan is now the sole executable revision authority. Capture
events still retain caller-supplied causal IDs, but after constructing the target
the module executes the exact exposed comparison plan and derives proposed
metadata from that state. Accepted metadata remains unchanged. An unchanged-byte
save produces no comparison action, retains the accepted file and metadata
revisions, and leaves no acknowledgement-pending graph change.

New end-to-end in-memory tests cover save/update, rename, reviewed create and
reviewed delete through capture, exact comparison-plan execution, resulting
snapshot construction, metadata validation and next-replica initialization.
Each resulting replica performs a second capture. Additional cases cover
unchanged-byte save, exact deterministic retry, pending/rejected behavior and
unchanged inputs.

- Corrected identity/capture suite: 29/29 passed.
- Existing core/planner/executor/comparison/response regressions plus the
  corrected suite: 75/75 passed.
- JavaScript syntax and diff checks passed.

No native helper, filesystem fixture, graph, sidecar, watcher, profile or app
was accessed. Real watcher capture, metadata persistence, stable working-tree
application and cross-device synchronization remain unimplemented.

## Stable synthetic working-folder experiment

The approved standalone slice adds `stable-working-tree.js` and a narrow
`F28WT1` x86_64 C helper beside the accepted publisher. The coordinator checks
the exact issued preview against the stable synthetic folder before publishing
the immutable generation. The working helper then applies the authoritative
plan per file, retains before-images, records an immutable request-bound journal
and synchronized progress markers, accepts exact projected metadata, and
acknowledges only after final verification. A deterministic in-memory watcher
classifier reconstructs exact cause records and separates matching echoes from
different content, presence, identity, operation or paths.

All filesystem evidence is retained in the one fresh owned run
`f28-working-tree-20260912-3b0d9af88-a1`; only explicit case names below it were
used. The shared root, other runs and user graphs were not enumerated or opened.
The first release cases passed 8/11. Three failures were test expectation
errors: completed recovery returns `applied` before later retries return
`already-applied`, and retained pre-journal staging causes a hard refusal rather
than a result object. The assertions were corrected without weakening the
helper. The next release passed 11/11. After adding selected-generation
initialization verification, parameter-directory/link refusal and injected
synchronization recovery, a later 11/12 run exposed that the test waited for
the child `exit` event but attempted the next lock acquisition before its stdio
and cleanup `close` event. Waiting for `close` made owned-process cleanup
explicit; the refusal and that run remain recorded. The final results were:

- Final warning-as-error x86_64 release integration: 12/12 passed.
- Final AddressSanitizer/UndefinedBehaviorSanitizer integration: 12/12 passed
  with `ASAN_OPTIONS=detect_leaks=0`.
- Relevant pure core/planner/executor/comparison/response/capture regressions:
  75/75 passed.
- JavaScript syntax and diff checks passed.

Cases cover create/update/rename/delete, one stable working-directory inode,
local edits before apply and between actions, explicit intermediate mixed state,
partial restart, files-complete/metadata-pending recovery, interrupted required
synchronization, acknowledgement loss, exact retry, matching watcher echoes
versus different edits, occupied create/rename destinations, contradictory
delete recovery, Korean NFC/NFD and case collisions, traversal, substituted
metadata-directory and working-file links, corrupt journal, incomplete staging,
and unchanged retained before-images/prior generations. Unexpected and
incomplete evidence remains in the synthetic run.

Apple Clang was 16.0.0 (`clang-1600.0.26.6`), targeting
`x86_64-apple-darwin23.6.0`. The tested working-helper C source SHA-256 was
`e93672c5b1c71db36b28f9e6990231aa988bcbe07d68a9a3f0ebe97935c5cf58`;
the release x86_64 helper SHA-256 was
`52bcea619aa886c62d4e68635429ba62dc57f7b64e2d1a44d053fdb61e26e444`.
Binaries and generated working files, metadata, journals and content-bearing
logs remain outside Git.

The result is preconditioned per-file application with recovery. It is not an
atomic compare-and-swap against arbitrary writers. The cooperative lock does
not control OG or editors, repeated checks leave check/write races, and an
interrupted batch is visibly mixed. Failure injection and successful
`F_FULLFSYNC` calls do not prove power-loss durability. The existing generation
can be selected before a later working-tree refusal, so recovery or a new
reviewed preview remains necessary. No real sidecar location, watcher, OG hook,
graph enrollment, application integration, account, network, encryption or
cross-device behavior was implemented.

## Default-off OG event bridge slice

The approved production-seam slice adds one removable
`frontend.fs.og-sync-bridge` namespace and minimal hook calls at the existing
save, rename and watcher boundaries. Its compile-time flag remains false and is
not enabled by any package. All operational state, serialized storage,
complete-state reads and reconciliation calls in the tests are injected,
in-memory fakes. No graph data, filesystem fixture, sidecar, profile,
application, native helper or network service was accessed.

The first focused run did not complete: two restart assertions used a load port
that closed over the wrong empty atom, and the overlap fixture tried to resolve
fake IPC before Promesa had invoked it. After correcting only those fixtures,
the next run exposed two more expectation/setup defects: the adapter was
intentionally blocked by the first completion before the second completion had
been sequenced, and the rename database stub returned an ID rather than the
synthetic file. These failed results were not treated as passing evidence. The
fixtures were made explicitly ordered and exact.

Final verification:

- Focused bridge and real OG-boundary tests: 15/15 tests, 60 assertions.
- Accepted pure core/planner/executor/comparison/response/identity regressions:
  75/75.
- Full ClojureScript test-build compilation succeeded (707 files in the final
  incremental build); its 25 inference/redefinition warnings are pre-existing
  repository warnings outside this slice.
- The production browser app target compiled successfully (1,381 files, zero
  warnings). It was not launched or packaged.
- Changed source and test lint passed with zero warnings, JavaScript syntax
  checks for the relevant identity and stable-working coordinators passed, and
  `git diff --check` passed.

The focused cases cover disabled save/rename/watcher settlement and ordering;
zero enabled-runtime work while disabled; pending, completed and failed causes;
adapter-failure isolation; overlapping saves and graph switches; incoming work
blocked by an unfinished local save; a different local edit remaining ordinary;
unique, zero and ambiguous complete watcher matching; reconciliation failure,
retry, recorded success and later echo classification; versioned ACTIVE
serialization; restart revalidation; tampered inputs; non-authoritative plans;
incompatible batches; persisted reconciliation progress; and refusal of
snapshot-only identity acceptance.

This remains synthetic infrastructure, not usable synchronization. The
reconciliation callback must be idempotent because a crash before its progress
record can cause a retry. No power-loss durability, real watcher stability,
sidecar placement, copied-graph decision, enrollment, native application,
account, network or cross-device behavior is established.

## OG bridge lifecycle correction

The preceding 15-test/60-assertion result remains historical evidence for the
initial default-off seam, but it did not exercise asynchronous reconciliation
settlement, pending rename conflicts, or authoritative validation of serialized
progress. The correction regressions were added first. Against the prior
behavior, the focused run had 15 failures in 20 tests/89 assertions: pending and
rejected promises were accepted prematurely, duplicate observations could be
misclassified, progress-store rejection did not prevent success, pending rename
paths did not block incoming work, and forged restart phase/progress could be
trusted. Those failures were retained as the gap-demonstration record rather
than described as passing.

The corrected bridge awaits reconciliation and ACTIVE/evidence storage ports.
An incoming cause is `reconciling` until reconciliation and its progress record
both settle successfully; duplicate exact observations do not start another
call, while either rejection returns the cause to `reconcile-pending`. Save and
rename cause identity remains bound to the originating graph and operation, and
both paths of a pending rename now participate in local-mutation conflict
checks. Synchronous hook ports reject thenables instead of silently treating
them as completed.

ACTIVE schema version 2 carries structured files-applied, reconciliation and
identity-acceptance receipt entries. On simulated restart, injected synthetic
authoritative ledgers validate those exact transaction/cause/operation bindings.
Serialized phase or a well-formed forged receipt is downgraded; unknown or
malformed entries are refused. A failed recovery retains evidence and blocks
later batches in that runtime.

Correction verification:

- Focused production-hook bridge tests: 22/22 tests, 105 assertions.
- Gap-demonstration run before correction: 20 tests, 89 assertions, 15 expected
  failures.
- Accepted pure core/planner/executor/comparison/response/identity regressions:
  75/75.
- Full ClojureScript test-build compilation: 707 files, 88 compiled, 25
  pre-existing inference/redefinition warnings and no new bridge warning.
- Production browser app compilation: 1,381 files, 148 compiled, zero warnings.
- Changed-file ClojureScript lint: zero warnings; relevant JavaScript syntax
  checks and `git diff --check`: passed.

All tests used synthetic in-memory storage, filesystem observations and events.
The bridge remains disabled in every package. Receipt ledgers are test ports,
not real durable storage; recovery remains idempotent/retryable rather than
exactly once. No graph, sidecar, helper, application, profile, account or network
integration was accessed or enabled.

## OG bridge asynchronous-overlap coordination correction

The preceding 22-test/105-assertion result remains historical evidence for the
lifecycle correction, but its bridge still modified the shared ACTIVE slot
outside any coordination boundary: `start-active!` checked for an existing
active transaction before its asynchronous binding validation and persistence,
reconciliation and lifecycle completions captured an ACTIVE snapshot and later
persisted and installed that stale snapshot across asynchronous gaps, and
recovery or completion could replace or clear a newer lifecycle installed while
its ports were pending. The overlap regressions were added first. Against the
prior behavior, the focused run had 21 failures in 31 tests/158 assertions:
two incompatible starts could both succeed, reversed reconciliation completions
lost one progress entry in memory and in the persisted record, reconciliation
overlapping files-applied progress reverted the phase and dropped the entry,
recovery could clobber a newer active record with memory/store divergence, a
delayed finish could clear a newer lifecycle's persisted record, and a
reentrant injected callback observed mid-flight state. Those failures were
retained as the gap-demonstration record rather than described as passing.

The corrected bridge adds one process-local coordination boundary, `serialized!`:
every runtime reserves FIFO coordination turns in call order, turns run one at a
time, and a rejected turn never stalls later turns. All six ACTIVE-publishing
operations (`start-active!`, `reconcile-incoming!` publication, `recover-active!`,
`mark-files-applied!`, `accept-identity!`, `finish-active!`) now claim their turn
before any asynchronous work and revalidate exact transaction ownership inside
the turn before each persisted write and in-memory installation. Reconciliations
reserve the owning transaction before their asynchronous reconciliation call and
enqueue their publication turn when the progress receipt settles, so reversed
completions publish in completion order and each merges one entry into the fresh
ACTIVE record instead of replacing it. Files-applied publication keeps the
current phase rather than regressing it and is idempotent; a stale finish
revalidates ownership after its asynchronous clear and cannot clear a newer
lifecycle; recovery runs as one turn and cannot race a start. A turn that
reenters the bridge from an injected callback reserves the next turn instead of
deadlocking. Save/rename hook behavior while disabled is unchanged.

Correction verification:

- Focused production-hook bridge tests: 31/31 tests, 158 assertions.
- Gap-demonstration run before correction: 31 tests, 158 assertions, 21 expected
  failures (all eight new overlap tests).
- Accepted pure core/planner/executor/comparison/response/identity regressions:
  75/75.
- Full ClojureScript test-build compilation succeeded; no new bridge warning.
- Production browser app compilation: 1,381 files, 148 compiled, zero warnings.
- Changed-file ClojureScript lint (`og_sync_bridge.cljs`,
  `og_sync_bridge_test.cljs`): zero warnings.

All overlap fixtures used deferred thenables, synthetic in-memory storage and
durable fake-store deserialization checks in addition to in-memory state and
returned results. The coordination boundary serializes only this process's
in-memory runtime state and synthetic persistence ports; it is neither a
cross-process lock nor crash durability, and no such claim is made. The bridge
remains disabled in every package. No graph, sidecar, helper, application,
profile, account or network integration was accessed or enabled.

## OG bridge blocked-recheck and uncertain-persistence correction

The preceding 31-test/158-assertion result remains historical evidence for the
overlap correction, but its serialized turns did not recheck the blocked latch
once a turn actually started, and `start-active!` treated a save rejection as
proof that nothing was persisted. Two failure cases motivated this correction.
First, a public call checks `blocked?` only before enqueueing its turn: recovery
could queue and await a deferred load, an incompatible start could queue behind
it while the runtime was still unblocked, and after recovery failed and latched
the runtime blocked the queued start still executed its body — performing its
binding validation, persistence and installation through a blocked runtime.
Second, a save rejection after the record was written returned
`:active-refused` and left no reservation, so a queued incompatible start could
overwrite the possibly persisted record while its true durable outcome was
unknown. The reentrancy test also covered only a callback that queues nested
work and returns its own receipt, not a callback that awaits it.

The regressions were added first. Against the prior behavior the focused run
had 29 failures and 3 errors in 38 tests/212 assertions: a queued start
performed its save after a failed recovery latched the runtime blocked; a
safety stop inside an awaited binding port did not stop the suspended turn from
saving and installing; an unproven save rejection left the store's record
unprotected against a queued incompatible start and returned
`:active-refused` instead of a typed uncertain outcome; a clear rejection
orphaned the in-memory owner with no validated-recovery path; proven no-write
failures and genuinely uncertain outcomes were indistinguishable; validated
recovery and the exact retry after an uncertain save had no specified
reservation, evidence-preservation or retry semantics.

The corrected bridge applies one rule uniformly: every coordination turn
rechecks the runtime's blocked latch at section start and after every awaited
port, refusing with typed `:coordination-blocked` results before its next
publication — start, recovery, reconciliation publication, progress,
acceptance and finish alike. A reconciliation that finds the runtime blocked at
any of its four publication boundaries settles its cause as retryable
reconcile-pending evidence without installing. For persistence, only a missing
save port (never invoked) or a port declaring `:proven-no-write` is a clean
refusal; any other save failure reserves the exact attempted envelope
(transaction ID, serialized bytes, failure) as `:uncertain-active` evidence and
returns `:active-save-uncertain`. While the reservation stands, only the exact
same transaction may retry; a successful republication or validated recovery
clears it. An uncertain clear rejection retains the installed owner, and
recovery's `:none` branch now treats the durable store as authoritative: an
empty store clears an orphaned in-memory owner (and any stale reservation),
while a validated load resolves an outstanding reservation and preserves the
exact evidence on failure. The `serialized!` contract is qualified: reentrancy
is supported only for callbacks that return without awaiting the nested turn;
the FIFO boundary does not detect or refuse an awaiting callback, and no
general deadlock-freedom claim is made.

Correction verification:

- Focused production-hook bridge tests: 38/38 tests, 212 assertions.
- Gap-demonstration run before correction: 38 tests, 212 assertions, 29
  expected failures and 3 errors (the seven new regression tests plus the
  updated asynchronous-active-storage assertion).
- Accepted pure core/planner/executor/comparison/response/identity regressions:
  75/75.
- Full ClojureScript test-build compilation succeeded; no new bridge warning.
- Production browser app compilation: 1,381 files, 148 compiled, zero warnings.
- Changed-file ClojureScript lint (`og_sync_bridge.cljs`,
  `og_sync_bridge_test.cljs`): zero warnings.

The new fixtures use controlled deferred synthetic ports and counting ports,
and assert returned typed results, operational call counts, runtime state,
blocked-latch phase, reservation contents and deserialized fake-store records
together. The reservation and blocked recheck are in-memory runtime semantics
over synthetic ports: they are not cross-process locking, not crash durability
and not a power-loss guarantee — a real crash between a durable write and its
acknowledgement is addressed only by future validated recovery designs. The
bridge remains disabled in every package. No graph, sidecar, helper,
application, profile, account or network integration was accessed or enabled;
the native-helper integration tests were deliberately not run in this batch.

## OG bridge recovery-evidence and uncertain-clear correction

The preceding 38-test/212-assertion result remains historical evidence for the
blocked-recheck correction, but its recovery path still conflated two distinct
kinds of unknown. First, `recover-active!` treated a missing persisted record as
proof of completed work: its empty-store branch unconditionally removed the
in-memory `:active` owner and any `:uncertain-active` reservation, so an
unfinished installed transaction whose record disappeared was silently
forgotten instead of preserved — the same branch also cleared ownership without
rechecking the blocked latch after its awaited load. Second, an uncertain clear
was not reserved: `finish-active!` returned a plain `:clear-active-failed`
after a clear rejection while retaining the accepted ACTIVE, so a direct
finish retry re-invoked the clear without any verified durable state and
reconciliation publication could republish the record that clear may already
have removed.

The regressions were added first. Against the prior behavior the focused run
had 36 failures in 45 tests/280 assertions: a missing persisted record while
an installed unfinished transaction was active still cleared ownership and
admitted other work; a verified-empty store did not resolve an uncertain
initial save's reservation; a clear-then-reject followed by a direct finish
retry repeated the clear with no recovery; an unexpected different record
during uncertain-clear recovery was installed over; a blocked latch set while
the empty load was pending was not rechecked before ownership changed; and
reconciliation publication resurrected the record an outstanding clear may
have removed. One new regression — a proven no-write clear refusal staying
separately retryable — passed before the change and guards that preservation.
One existing assertion was updated because it encoded the corrected-away
orphan-clear behavior.

The corrected bridge applies the uncertain-save rule to clears and the
evidence rule to empty stores. A clear rejection without proven-no-write
evidence reserves the exact accepted transaction (ID, serialized envelope,
failure) as an outstanding `:uncertain-clear` reservation and returns
`:clear-active-uncertain`; a proven no-write clear refusal remains separately
retryable with no reservation. While the reservation stands a repeat finish
and every start are refused, and reconciliation publication settles its cause
as retryable reconcile-pending evidence instead of writing progress.
`recover-active!` rechecks the blocked latch after its awaited load and settles
an empty store only where the retained evidence supports it: an idle runtime
reports `:none`; verified absence resolves an uncertain-save reservation
(`:resolved :uncertain-save`); verified absence confirms a matching
outstanding uncertain clear (`:resolved :uncertain-clear`); anything else
installed in memory fails with `:missing-active-record`, preserving the owner,
the typed evidence and the blocked latch. A loaded record matching an
outstanding reservation clears that reservation on install; a different
record fails with `:unexpected-active-record`, preserving the stored record,
the in-memory owner and the reservation rather than installing over them.
Recovery evidence now records the failure's typed code.

Correction verification:

- Focused production-hook bridge tests: 45/45 tests, 280 assertions.
- Gap-demonstration run before correction: 45 tests, 280 assertions, 36
  expected failures (six new regression tests plus the updated
  validated-recovery assertion; the seventh new regression passed before the
  change as an intentional preservation guard).
- Accepted pure core/planner/executor/comparison/response/identity regressions:
  75/75.
- Full ClojureScript test-build compilation succeeded; no new bridge warning.
- Production browser app compilation: 1,381 files, 148 compiled, zero warnings.
- Changed-file ClojureScript lint (`og_sync_bridge.cljs`,
  `og_sync_bridge_test.cljs`): zero warnings, zero errors.

The new fixtures use controlled deferred synthetic ports, counting ports and a
shared fake store, and assert returned typed results, operational call counts,
runtime state, blocked-latch phase, reservation contents and deserialized
fake-store records together. The uncertain-clear reservation and the
missing-record evidence are in-memory runtime semantics over synthetic ports:
they are not cross-process locking, not crash durability and not a power-loss
guarantee — a real crash between a durable clear and its acknowledgement, or
a store whose record vanishes for reasons outside this process, is addressed
only by future reviewed recovery designs. The bridge remains disabled in
every package. No graph, sidecar, helper, application, profile, account or
network integration was accessed or enabled; the native-helper integration
tests were deliberately not run in this batch.
