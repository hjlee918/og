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
