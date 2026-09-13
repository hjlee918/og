# Synthetic file identity and change-capture design

Status: the bounded pure in-memory batch is implemented. The sidecar,
filesystem, watcher and OG portions remain proposals. This design does not
enroll an OG graph, read a graph, run a watcher, or change note contents. It is
not OG integration or production sync.

## Recommendation

Add one versioned, app-owned identity sidecar and a pure capture state machine.
The sidecar maps explicit graph/file IDs to ordinary Markdown/Org paths and
accepted revisions. It never puts IDs in note text and never assigns block IDs.
The first implementation should accept only a caller-supplied synthetic file
list and controlled synthetic events. It should produce review items and an
explicit target snapshot for the existing comparison/preview path, but perform
no filesystem or OG operation.

For eventual real enrollment, the proposed location is
`logseq/.og-sync/identity-v1.json`. OG's recursive graph reader excludes hidden
paths, and its watcher uses the same ignored-path rule
([graph.cljs](../deps/common/src/logseq/common/graph.cljs#L20-L40),
[graph.cljs](../deps/common/src/logseq/common/graph.cljs#L42-L72)). This is a
new format and must not be confused with `logseq/graphs-txid.edn`, whose current
meaning is a hosted-sync tuple containing user UUID, server graph UUID and
transaction ID ([sync.cljs](../src/main/frontend/fs/sync.cljs#L44-L52)). Whether
the proposed sidecar travels inside a graph folder or through an explicit
export/import bundle is the one compatibility decision required before real
graph support. The first pure batch does not depend on that decision.

## Verified OG source findings

- Editor transactions invoke the outliner file pipeline
  ([pipeline.cljs](../src/main/frontend/modules/outliner/pipeline.cljs#L12-L15)).
  Writes are queued, rate-limited and deduplicated by page and outliner
  operation before `save-tree!`
  ([file.cljs](../src/main/frontend/modules/outliner/file.cljs#L46-L77),
  [file.cljs](../src/main/frontend/modules/outliner/file.cljs#L86-L117)). The
  rendered page bytes then reach `alter-files-handler!`
  ([core.cljs](../src/main/frontend/modules/file/core.cljs#L146-L176)), which
  calls the filesystem write API
  ([file.cljs](../src/main/frontend/handler/file.cljs#L203-L234)). The Node
  implementation compares current disk and database text before its IPC write
  and updates database state after the write returns
  ([node.cljs](../src/main/frontend/fs/node.cljs#L21-L66)). A future adapter can
  add a completion signal at this boundary; an editor transaction or queue entry
  alone is not evidence that bytes reached disk.
- OG page rename has a specific source signal containing `repo`, `old-path` and
  `new-path`, followed by `fs/rename!`
  ([page.cljs](../src/main/frontend/handler/page.cljs#L201-L227),
  [state.cljs](../src/main/frontend/state.cljs#L2190-L2198)). Existing sync code
  turns this signal into an unlink/add pair and suppresses matching raw watcher
  events for three seconds
  ([sync.cljs](../src/main/frontend/fs/sync.cljs#L1927-L1981)). The signal is
  offered before the filesystem rename, so it proves OG rename intent, not
  rename completion.
- Raw watcher delivery supplies add/change/unlink with path, content and stat.
  It uses `awaitWriteFinish`; unlink is delayed 500 ms and emitted only if the
  path still appears absent
  ([fs_watcher.cljs](../src/electron/electron/fs_watcher.cljs#L61-L75),
  [fs_watcher.cljs](../src/electron/electron/fs_watcher.cljs#L76-L122)). The
  renderer reconciles those events by path and content, and treats unlink as a
  page deletion when the path exists in its database
  ([watcher_handler.cljs](../src/main/frontend/fs/watcher_handler.cljs#L58-L110)).
  These events contain no stable file identity and do not distinguish an
  external rename from delete-plus-create.
- On local external changes, OG may infer block UUID placement by diffing the
  old database and new AST
  ([file.cljs](../src/main/frontend/handler/common/file.cljs#L57-L93)). File
  serialization also persists a block UUID only in particular reference cases
  ([core.cljs](../src/main/frontend/modules/file/core.cljs#L34-L89)). Therefore
  this design neither assumes every block has a persisted UUID nor uses that
  heuristic for file identity.
- OG has special handling for case-only path changes because macOS may not emit
  a watcher event
  ([file.cljs](../src/main/frontend/handler/common/file.cljs#L24-L49)). That is
  another reason to keep explicit rename intent and normalized collision checks
  separate from watcher inference.

## Identity sidecar contract

The exportable sidecar schema is `f28-file-identities/1`:

```text
graphId, metadataRevision
files[fileId] = {path, normalizedPath, acceptedRevision,
                 acceptedContentHash, status}
tombstones[fileId] = {lastPath, acceptedRevision}
```

`graphId` and every `fileId` are opaque random identifiers in a future real
adapter. In the first synthetic batch, the caller supplies them explicitly so
tests remain deterministic. IDs never derive from path, content, inode, mtime,
page name or block UUID. `replicaId`, watcher cursors and pending local delivery
state are device-local records and are not copied as graph identity.

Enrollment requires an explicit complete list of approved synthetic files and
an absent identity sidecar. It validates unique IDs, exact paths, supported
extensions and collision keys before returning metadata. It does not scan a
folder. A second replica receives the same sidecar with the explicitly
transferred graph files, keeps the graph/file IDs, and receives a new local
`replicaId`. Content hashes verify the claimed enrollment state; they do not
create or authenticate identity.

Paths are retained exactly for display and materialization. Collision keys use
Unicode NFC plus the prototype's conservative case-insensitive comparison.
Two byte-distinct Korean NFC/NFD names or case variants with the same key are a
conflict. Neither entry is renamed, merged or discarded. Platform-specific
case-folding behavior remains future compatibility work.

## Capture and ambiguity rules

The pure state machine consumes an accepted metadata revision, an accepted
replica snapshot, and ordered synthetic observations. It returns unchanged
inputs plus `capturedEvents`, `pendingObservations`, `reviewItems` and a proposed
target snapshot.

1. **OG save.** A save candidate becomes an update only after a future OG seam
   reports write completion and a stable observation matches the expected file
   ID, path and complete bytes. Queueing or editor state is insufficient.
2. **OG rename.** Rename intent reserves the old/new paths but does not move the
   identity. Completion requires the corresponding rename call to succeed and
   a stable observation of the new path while the old path is absent. Failure or
   mismatch preserves the old mapping and the pending intent for review.
3. **External changes.** A stable change at the sole current path of a known ID
   may propose an update. External unlink and add remain separate observations;
   they never become a rename because text, path or inode happens to match. An
   external add has no file ID until an explicit review action assigns one. An
   unlink is pending absence, not a tombstone, until an explicit delete or a
   reviewed complete snapshot authorizes deletion.
4. **Writes and notifications.** A future filesystem collector must use
   contained, non-following opens and bounded reads, compare file identity/stat
   before and after the read, and accept only a complete stable byte snapshot.
   Atomic replacement may change inode without changing file ID; inode is only
   transient consistency evidence. Incomplete/changing reads remain pending and
   do not advance the accepted baseline. `awaitWriteFinish` is useful debounce,
   not a completeness guarantee. A deterministic capture ID over graph ID,
   file ID, base revision, semantic event, exact path/content hash and any OG
   intent ID makes repeated equivalent notifications idempotent.
5. **Ambiguity.** All candidate bytes, paths, timestamps supplied by the event
   source and causal intent references are retained in a bounded review item.
   The accepted mapping and revision remain unchanged. Review must explicitly
   choose create, update, rename, delete, or ignore; the machine never guesses.

If the sidecar is missing for a graph that claims prior enrollment, capture is
disabled and notes remain untouched. A stale metadata revision, unknown graph
ID, duplicate file ID, impossible revision ancestry, or collision produces a
rejected batch plus retained diagnostics. A sidecar copied with the wrong files
does not cause re-identification: mismatched hashes/paths are review items. The
user must provide the correct sidecar or explicitly create a new graph lineage;
automatic re-enrollment and sidecar merging are excluded.

## Entry into the accepted workflow

Only a wholly valid, reviewed capture result may construct
`f28-synthetic-target/1` input for the accepted snapshot comparison. It carries
the explicit file IDs, exact paths/content, explicit tombstones, and the
complete/deletion-authorization flags. The existing comparison then produces
schema `f28-snapshot-comparison/2`; conflicts or invalid inputs keep
`eligibility=false` and `plan=null`. Preview remains read-only, and apply remains
bound to the exact preview, selected generation, source snapshot, target and
plan. Review diagnostics are never sent to the publisher as operations.

The comparison plan, rather than the earlier causal capture event, owns final
executable revision IDs. Proposed identity metadata must be derived by executing
that exact plan in memory. Causal revision IDs remain evidence only. This also
means an unchanged-content save advances neither file revision nor metadata
revision.

The current filesystem experiment publishes immutable complete generations
selected through `CURRENT`. OG, however, edits one stable working graph path.
No accepted component safely materializes a selected generation back into that
working tree while coordinating OG saves, watcher echoes, external editors and
metadata updates. A later integration must keep OG on its stable path and add a
recoverable working-tree application/capture boundary; switching OG's graph
path for every edit is not proposed. Cooperative prototype locks do not exclude
OG, Finder, cloud agents or other editors, and this design does not close that
gap.

## Smallest implementation batch after review

Implement a standalone pure module beside the existing comparison adapter:

1. Define and validate `f28-file-identities/1`, explicit synthetic enrollment,
   replica-copy initialization and metadata revision preconditions.
2. Reduce controlled save-complete, rename-intent/complete, external
   add/change/unlink and stable-read-failure observations into deterministic
   captured events or review items.
3. Produce the explicit target snapshot and call the existing pure comparison
   function only when capture eligibility is true. Do not call the
   filesystem-reading `previewComparison`, native helper or publisher.
4. Test path-independent IDs, replica carry-over, save deduplication, failed and
   completed rename, external delete-plus-create ambiguity, incomplete writes,
   repeated notifications, missing/stale/wrong sidecars, NFC/NFD and case
   collisions, deterministic output and unchanged inputs.

This batch proves the metadata and event-classification contract with synthetic
inputs. It does not prove real watcher completeness, OG write/rename hooks,
filesystem enrollment, sidecar portability, mobile background delivery,
working-tree application or cross-device synchronization.

Before any real graph implementation, the user must approve the material
compatibility choice: **recommended**—store the versioned sidecar at the ignored
in-graph path above so it can travel with a graph; alternative—require a
separate explicit identity-bundle export/import, which is more visible but can
be separated from the files it identifies. No decision is needed to build the
proposed pure synthetic batch.
