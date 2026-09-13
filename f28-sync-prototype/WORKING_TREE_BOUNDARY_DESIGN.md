# Stable working-tree capture/application boundary

Status: bounded synthetic implementation completed, 2026-09-12. The working
folder, metadata and watcher simulation remain test-only. No real sidecar
location, watcher hook, graph enrollment or OG integration is approved. The
accepted pure capture tests are 75/75; the comparison plan owns executable
revision identities.

## Recommendation

Keep OG on its existing stable graph directory and add one **preconditioned
per-file applicator with recovery** around the accepted plan. The applicator uses a
synchronized transaction journal, exact before/after bytes and paths, and retained
prior versions. It stages a complete batch, but publishes each working-tree
file separately. It therefore provides recoverable per-file transitions, not
whole-graph atomicity.

The immutable selected generation remains the preview basis and retained sync
history. It does not become OG's live graph path. Identity metadata remains
separate from Markdown/Org content, and its eventual storage location is a
required parameter named `metadataRoot`; this design does not choose or create
a sidecar location.

Only the adapter's own processes honor its cooperative lock. OG, Chokidar,
Finder, cloud agents and external editors do not. The lock serializes
participating adapters; exact file preconditions and post-write verification
detect intervening uncoordinated writes. They cannot prevent an arbitrary
writer from racing after a check.

## Precise OG source seams

1. **OG save intent and completion.** Editor transactions enter
   `updated-page-hook`, then the queued/rate-limited outliner writer
   ([pipeline.cljs](../src/main/frontend/modules/outliner/pipeline.cljs#L12-L15),
   [file.cljs](../src/main/frontend/modules/outliner/file.cljs#L46-L77),
   [file.cljs](../src/main/frontend/modules/outliner/file.cljs#L86-L117)).
   Serialization reaches `alter-files-handler!`, whose promise completes after
   the filesystem requests
   ([core.cljs](../src/main/frontend/modules/file/core.cljs#L146-L176),
   [file.cljs](../src/main/frontend/handler/file.cljs#L203-L234)). The narrow
   future seam is `write-file-impl!`: immediately before the IPC call, record a
   cause and expected base; only after `writeFile` returns and the database
   content/mtime are updated may it emit save completion
   ([node.cljs](../src/main/frontend/fs/node.cljs#L21-L66)). A queued editor
   transaction alone is not disk evidence.
2. **OG rename intent and completion.** `rename-file!` supplies the exact old
   and new paths, but currently offers its rename event before `fs/rename!`
   resolves ([page.cljs](../src/main/frontend/handler/page.cljs#L201-L227),
   [state.cljs](../src/main/frontend/state.cljs#L2190-L2198)). A future hook
   must assign a cause ID at intent and emit completion only after the rename
   promise succeeds. The current three-second path suppression in hosted sync
   is not a completion or identity protocol
   ([sync.cljs](../src/main/frontend/fs/sync.cljs#L1927-L1981)).
3. **External and incoming reconciliation.** The Electron watcher reads bytes
   and stat and publishes add/change/unlink events; `awaitWriteFinish` and the
   delayed absence probe are debounce evidence, not a stable-read guarantee
   ([fs_watcher.cljs](../src/electron/electron/fs_watcher.cljs#L49-L75),
   [fs_watcher.cljs](../src/electron/electron/fs_watcher.cljs#L76-L122)). The
   renderer compares path/content and applies disk changes using
   `from-disk? true`
   ([watcher_handler.cljs](../src/main/frontend/fs/watcher_handler.cljs#L44-L110)).
   A future public reconciliation entry point beside this handler should accept
   an exact cause, path, content hash and operation type, reconcile the incoming
   result once, and deduplicate only matching watcher echoes.
4. **Filesystem mutation.** Main-process writes currently use `writeFileSync`,
   rename uses `renameSync`, and delete normally moves a file into
   `logseq/.recycle`
   ([handler.cljs](../src/electron/electron/handler.cljs#L63-L86),
   [handler.cljs](../src/electron/electron/handler.cljs#L164-L202)). The first
   synthetic batch must not change these OG paths. Later integration would
   route incoming application through the anchored helper instead of claiming
   these pathname operations satisfy the prototype boundary.

OG also has case-only path reconciliation because macOS can omit the expected
watcher event ([file.cljs](../src/main/frontend/handler/common/file.cljs#L24-L49)).
Its block UUID diffing for external content is unrelated to file identity and
is not reused here
([file.cljs](../src/main/frontend/handler/common/file.cljs#L57-L93)).

## Working-tree contract and normal sequence

The journal schema `f28-working-tree-transaction/1` binds transaction ID,
exact preview/plan/basis fingerprints, metadata revision, ordered operation
IDs, and for every file: file ID, exact old/new paths, normalized collision
keys, old/new presence, revision IDs and content hashes. Each action has
`prepared`, `applied`, and `verified` markers. Journal records and before-image
references are retained until a separately approved policy permits cleanup.

1. Under the adapter lock, verify the selected generation and exact preview.
   Ask the simulated editor (later OG) to finish its known pending writes, then
   read every affected working file through anchored, non-following handles.
   Compare exact bytes, presence and path with the accepted working-tree basis.
   A mismatch is a local change or ambiguity; return it to capture/review and
   do not silently rebase.
2. Reject duplicate IDs and any NFC-plus-conservative-case-fold collision
   across existing and proposed paths. Preserve exact UTF-8 Korean/English
   paths. Never silently normalize, merge or rename. A case-only or NFC/NFD
   equivalent rename is refused in the first batch because its safe platform
   sequence is not yet implemented.
3. Exclusively create the transaction journal and transaction-owned staging
   files through anchored handles. Store exact intended after bytes and
   retained before bytes/references. Flush and reread them before marking the
   journal `PREPARED`. Preparation changes no live note.
4. Immediately before each action, recheck its exact old path, content hash and
   presence, plus destination absence/collision conditions. Create/update uses
   a same-directory staged file and one anchored replacement for that file.
   Rename requires the old exact file and an absent exact destination. Delete
   uses an anchored move into the transaction recovery area and records a
   tombstone; it is never inferred from absence. Flush the affected file and
   directory as required, reread the result, then synchronize that action's
   journal marker. Other files may already be visible at this point.
5. After all actions, reverify every intended working path and byte sequence.
   Derive proposed identity metadata from the exact comparison plan's resulting
   state, persist it at the parameterized metadata boundary, and verify it
   against those files. Only then mark `METADATA_ACCEPTED`, synchronize the
   journal/metadata directories and acknowledge. An exact retry verifies the
   same files, plan and accepted metadata and creates no duplicate operation.

The editor flush in step 1 covers only writes known to the cooperative app
hook. Every per-file check remains necessary because an external writer can
change a file during the batch.

## Watcher feedback and new local edits

Register an in-memory cause record before an OG or incoming write with the
exact file ID, operation, before/after paths and after hash. Path or elapsed
time alone never identifies an echo.

For an incoming change, invoke the future reconciliation entry point exactly
once after the file action verifies, using `from-disk? true`; matching later
watcher notifications become duplicate observations. A notification with
different bytes, presence or path is a genuine local/external observation and
must enter capture or review even while a cause is outstanding. Repeated exact
notifications remain idempotent. Cause state is reconstructed from the durable
journal after restart, so a crash cannot turn all later events into ignored
echoes.

## Interrupted sequence and recovery

Recovery acquires the adapter lock, validates the journal and selected basis,
then classifies every affected file from exact bytes/path/presence:

- **Journal prepared; no action applied:** continue only if all before states
  still match. Otherwise preserve staging and report conflict.
- **Some actions applied:** an exact after state confirms that action; an exact
  before state may still be applied. Any third state stops recovery. Do not
  roll back over a possible user edit, and do not accept metadata yet.
- **All files applied; metadata pending:** reverify the full intended working
  state, then persist and validate metadata derived from the authoritative
  plan. If any file changed, retain the journal and send the observation to
  review.
- **Metadata accepted; acknowledgement missing:** verify the exact transaction,
  files and metadata, then acknowledge the retry without reapplying.

A change arriving during recovery is handled by the same three-state rule. It
is retained as a pending local observation and requires a new reviewed preview;
recovery never guesses whether it supersedes the incoming revision. This
roll-forward policy preserves the old generation, staged bytes, moved deletes
and journal. It does not make a multi-file batch atomic.

## Implemented bounded synthetic batch

The approved batch implements this contract only for a fresh synthetic working
directory and a simulated editor. It reuses the accepted pure
capture/comparison/planner/executor and generation publisher. A separate narrow
x86_64 C command boundary performs anchored working-file and synthetic metadata
operations. It adds the versioned journal, per-file preconditioned
create/update/rename/delete commands, and a deterministic watcher-event
classifier. `metadataRoot` remains an injected synthetic path. OG source and
Chokidar are unchanged.

Acceptance tests should cover normal operations; an editor write before apply
and between file actions; partial apply/restart; files-complete/metadata-pending
recovery; acknowledgement loss and exact retry; exact watcher echo versus a
mismatched user edit; create/delete and rename/destination races; explicit
tombstone recovery; Korean NFC/NFD and case collisions; corrupt journal/stage;
and unchanged before-images and selected generations after refusal. Tests must
assert the intermediate mixed working-tree state rather than describe it as
atomic.

This batch proves that the accepted plan can be materialized and recovered at
one stable synthetic path while preserving concurrent simulated edits. It does
not prove real watcher stability, arbitrary-writer exclusion, real OG save
coordination, power-loss durability, mobile behavior or cross-device sync.

## Non-goals, risks and approvals

There is no block identity matching, note rewrite, automatic enrollment,
sidecar merge, network/account/encryption work, attachment protocol, Roam
import, hosted service or graph-path switching. External applications can still
race after any verification. Per-file replacement means OG may temporarily see
a mixed batch; later OG integration needs an explicit reconciliation pause and
resume protocol, without claiming filesystem exclusion.

Approval to create and mutate one new test-owned working directory under the
exact approved `Logseq Test` root and compile/execute the test-only x86_64 C
helper was granted and used for this batch. The implementation does not claim
an atomic compare-and-swap operation against external writers: the cooperative
lock and repeated precondition checks still leave check/write races.

Two later compatibility decisions require separate approval: where exportable
identity/journal metadata lives, and whether OG may add save/rename completion
causes plus one exact incoming-reconciliation seam. Those hooks change OG event
behavior and must be reviewed before application integration.
