# Synthetic filesystem application boundary

Status: implementation-ready recommendation, 2026-09-12. No filesystem
executor, fixture, OG integration or durability claim has been implemented or
approved. This design applies only to a fresh synthetic Intel test run.

## Recommendation

Use a small macOS native helper to hold verified directory handles and publish
**immutable complete generations**. Each generation contains the ordinary
synthetic note files, the exact revision/operation state and a hash manifest.
A `CURRENT` record selects one complete generation. Build and sync the next
generation first, then replace `CURRENT` with one directory-relative rename.

The rename publishes one selector for participating readers. It does **not**
make the preceding multi-file writes atomic. A generation becomes eligible for
publication only after every file, state record, manifest and containing
directory has passed its required write, hash and synchronization checks.

## Verified platform semantics

- POSIX `openat()` resolves a relative path from an open directory descriptor;
  `O_CREAT | O_EXCL` makes existence-check plus creation atomic for callers
  naming the same entry, and `O_NOFOLLOW` refuses a final symbolic link
  ([The Open Group `open`/`openat`](https://pubs.opengroup.org/onlinepubs/9799919799/functions/open.html)).
- POSIX `renameat()` resolves source and destination relative to directory
  descriptors. Its single rename is an atomic namespace operation; that
  guarantee does not cover a set of other file writes
  ([The Open Group `rename`/`renameat`](https://pubs.opengroup.org/onlinepubs/9799919799/functions/rename.html)).
- macOS `flock()` is advisory: it coordinates processes that use the same lock,
  while other processes may still access files and create inconsistencies
  ([Apple `flock(2)`](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/flock.2.html)).
- Apple documents that `fsync()` alone can still leave missing or reordered
  writes after power loss and identifies `F_FULLFSYNC` as the stronger macOS
  request for ordered permanent-storage flushing
  ([Apple `fsync(2)`](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/fsync.2.html)).

The installed Intel SDK was also checked directly: Apple clang targets
`x86_64-apple-darwin23.6.0`; macOS SDK headers declare `openat()` and
`renameat()` from macOS 10.10, `flock()`, and `F_FULLFSYNC`. These declarations
show availability, not successful behavior on every filesystem. The future
implementation must fail closed when a required operation is unsupported.

## Two practical approaches

| Approach | Recovery and file/state consistency | Decision |
|---|---|---|
| Immutable generation plus `CURRENT` selector | Incomplete staging is not selected. Files and revision state are verified together inside one generation. Restart validates the old or new selected generation and preserves every prior generation. It uses extra space and a future OG adapter would have to open the selected generation. | **Recommended for the bounded synthetic prototype.** It has the smallest recovery state machine and no partially published generation for participating readers. |
| In-place files plus write-ahead batch journal | Keeps one stable graph path, but each update/rename/delete becomes visible separately. Recovery must distinguish old, staged, moved and replaced states for every file, then roll forward without overwriting an external edit. The state record can lag file changes until recovery completes. | Defer. It is closer to eventual OG integration but creates the general-purpose filesystem transaction framework this slice should avoid. |

## Boundary and participating writers

Use one narrow x86_64 C command helper built with the installed Apple Clang
toolchain, CommonCrypto and Darwin system calls. No third-party package is
needed. A bounded, fixed-order, hex-encoded line protocol avoids adding a JSON
parser to C; duplicate, missing, reordered and oversized fields fail closed.
The Node coordinator may run the accepted planner/executor, but all
filesystem operations and the cooperative lock remain in one helper process for
the complete session.

The originally approved Swift attempt remains under `native/failed-swift/` as
inactive historical evidence. It never compiled or ran: Swift `6.0.3.1.10`
rejected SDK modules built with `6.0.3.1.5`. The user approved the C substitution
after that blocker. No SDK was modified and no compiler safety check was
bypassed.

At startup the helper must:

1. Accept only the fixed approved root, one exact fresh child name and an
   explicit test-run ownership token. Reject absolute child input, separators,
   `.`/`..`, empty names and the approved root itself before data access.
2. Open `/` and walk every approved-root component using `openat()` with
   directory and no-follow flags. Open the named test child and internal
   directories the same way; verify type, device/inode identity and owner marker
   with `fstat()`. Keep these handles open and use only handle-relative calls.
3. Open the fixed lock entry with no-follow/exclusive-creation rules, verify its
   recorded inode, and take `flock(LOCK_EX | LOCK_NB)`. Refuse a second helper.
4. Recover any known prepared generation before accepting a new batch. Never
   enumerate the shared `Logseq Test` root; inspect only fixed internal names or
   the exact transaction named by the supplied plan ID.

For a fresh owned child with no internal store, exclusively create the fixed
metadata entries and publish one verified empty genesis generation before
accepting events. If some but not all expected entries already exist, refuse
initialization and preserve them.

The lock coordinates only this prototype's helper processes. The participating
writers are the single coordinator/helper pair and later restarts using the same
protocol. OG, watchers, Finder, editors, cloud-provider agents and arbitrary
processes do not honor this lock. The prototype test instructions must prohibit
those writers. Hash/identity checks can detect some outside changes, but the
lock cannot prevent them.

An open directory handle stays bound to the inode that was verified; replacing
a pathname component cannot redirect later relative calls to a substituted
directory. It does not stop an outside actor from moving that anchored inode or
one of its ancestors outside the approved root. The helper rechecks that the
fixed path still resolves to the recorded device/inode at phase boundaries and
refuses a detected change, but this is not a race-free proof of continuing
ancestry. The first batch is therefore limited to a controlled single-writer
test child whose ancestors are not renamed by nonparticipating processes.

## Compare, stage, publish and acknowledge

Under the held lock and open handles:

1. **Compare.** Open the selected generation through `CURRENT`; verify its
   manifest, state fingerprint and every affected file's exact path/content
   hash. Recompute and execute the in-memory plan. Reject snapshots containing
   any unresolved branch anywhere, because the first materializer has no rule
   for choosing a visible head. Immediately before staging, repeat the basis
   and affected-file checks. A mismatch is stale; never rebase silently.
2. **Stage.** Exclusively create
   `.f28-sync/generations/<plan-id>.staging`. Copy every current synthetic file
   into it rather than hard-linking mutable inodes; apply the validated actions
   only to these copies. An explicit delete omits its path and remains a
   tombstone in state. A rename writes the same bytes at the explicit new path.
   Create the projected state and a canonical manifest containing plan/batch
   IDs, basis/projected fingerprints, operation IDs, exact paths and content
   hashes. Preserve exact Korean/English bytes and normalized collision keys.
3. **Prepare.** Flush each regular file with the strongest supported Intel
   policy selected for the prototype (`F_FULLFSYNC` is the candidate), then
   sync opened generation directories. Write the manifest last as `PREPARED`,
   flush it and re-read all hashes through the anchored handles. Any unsupported
   or failed durability call is a refusal, with staging preserved.
4. **Publish.** Revalidate the selected basis, affected source files and the
   recorded root/child identities through the held handles. Exclusively create
   and flush `CURRENT.<plan-id>.pending`, whose
   contents name only the prepared generation and manifest hash. Use
   `renameat()` within the already-open metadata directory to replace `CURRENT`,
   then sync that directory. Reopen `CURRENT`, the generation, manifest, state
   and affected files through anchored handles and verify the projected
   fingerprint and hashes.
5. **Acknowledge.** Return success only after the post-publication verification
   and synchronization calls succeed. Record no earlier acknowledgement. Keep
   the prior selected generation and all incomplete evidence; retention cleanup
   is outside the first batch.

## Restart and conservative recovery

- No valid `PREPARED` manifest: never publish that staging generation. Preserve
  it as evidence and continue from the valid `CURRENT` generation only.
- Valid prepared generation and `CURRENT` still names the exact basis: recheck
  every hash and complete publication. Missing or unexpected content refuses
  recovery.
- `CURRENT` names the prepared generation and all manifest/state/file checks
  pass: treat the operation IDs as an exact already-applied batch, redo required
  synchronization, and acknowledge the retry without creating another
  generation.
- `CURRENT` names neither the basis nor that exact projected generation, or any
  selector/generation/hash is missing or inconsistent: fail closed and preserve
  all generations. Do not guess, merge, roll back or delete evidence.

This is roll-forward publication. Restoring an older version remains a new
planned revision and generation; it never rewrites or deletes history.

## Focused future test matrix

All future tests require one new canonical test-owned child under the approved
root and separate approval for filesystem mutation.

- Root/child traversal, symlink and ownership-token refusal before content read.
- Second-helper lock refusal and release after normal exit and forced process
  death; demonstrate only cooperative ownership.
- Stale state or affected-file change before staging and immediately before
  publication.
- Failure after each staged file, before/after `PREPARED`, before/after selector
  rename, during directory sync and before acknowledgement.
- Restart from every retained phase: old generation stays selected, valid
  prepared generation rolls forward, exact published retry is idempotent, and
  unknown state fails closed.
- Corrupt/missing manifest, state, pointer and staged file; altered Korean
  NFC/NFD paths; duplicate operation IDs; rename/delete/create collisions.
- Verify prior generations unchanged and file bytes, state fingerprint,
  operations and selected manifest agree after every acknowledged batch.

Controlled exceptions, process kills and syscall-failure injection do not prove
real power-loss behavior. A separate destructive power-loss campaign is not
part of the first implementation batch.

## Recommended implementation batch and approvals

The approved batch implements only the x86_64 C helper, its narrow session
protocol, a Node test coordinator and failure-injection hooks. Support small
UTF-8 synthetic Markdown/Org files, complete-generation copying and one writer.
Do not connect OG or accept an existing graph. Stop if the target volume lacks a
required syscall/durability behavior; do not fall back to pathname-only writes.

The two approvals required for this batch were granted:

1. Approval to add, compile and execute a test-only native helper using the
   installed Apple toolchain, later changed from blocked Swift to C. This adds a
   native build artifact and subprocess boundary, though no third-party
   dependency or administrator privilege.
2. Approval for that helper's tests to create and mutate one fresh synthetic
   child under the exact `Logseq Test` root. No existing run or graph would be
   opened.

Windows needs equivalent handle-relative primitives and separate validation.
iOS cannot assume a desktop helper process or uninterrupted background time;
Android has different APIs and lifecycle limits. Those adapters, along with
accounts, network, encryption, attachments, real graph enrollment, block
matching, Roam import and OG watcher integration, remain excluded.
