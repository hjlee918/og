# Bounded OG integration design

Status: implementation-ready recommendation, 2026-09-12. Documentation and
source review only. The standalone working-folder experiment is accepted within
its recorded limits. No OG hook, sidecar, graph enrollment, application launch
or real-file integration is implemented or approved.

## Recommendation and metadata boundary

Keep ordinary Markdown/Org files at OG's existing graph path. Store portable
graph/file identity in the ignored graph-local sidecar
`logseq/.og-sync/identity-v1.json`, subject to user approval. Store replica-local
operational state under the application's data root, keyed by `graphId` and
`replicaId`: active transaction envelopes, pending causes, staging/recovery
locations and local cursors. The exact app-data path remains a platform adapter
choice; it must never use a normal OG profile implicitly.

| Location | Moves, copies and recovery | Decision |
|---|---|---|
| Graph-local only | A graph move or backup naturally carries identity. A copied folder also copies `graphId`, so two independent graphs can accidentally share a lineage. Device identity and in-flight recovery would travel when they must remain device-local. | Use only for accepted portable identity. |
| App-local only | Leaves the graph folder unchanged, but path mappings can be lost after a move, a graph-only backup cannot restore identity, and recognizing a copy becomes dependent on local state that another device does not have. | Reject as the sole identity store. |

OG's recursive reader excludes symbolic links and dot-prefixed paths, and the
watcher applies the same hidden-path rule
([graph.cljs](../deps/common/src/logseq/common/graph.cljs#L20-L40),
[graph.cljs](../deps/common/src/logseq/common/graph.cljs#L42-L72)). The proposed
sidecar therefore stays outside normal note parsing and watcher reconciliation.
It is distinct from `logseq/graphs-txid.edn`, which belongs to OG's existing
hosted-sync protocol
([sync.cljs](../src/main/frontend/fs/sync.cljs#L44-L52)).

The sidecar contains accepted `graphId`, file IDs, exact paths, normalized
collision keys, accepted revision/content hashes, tombstones,
`metadataRevision`, `acceptedTransactionId`, accepted snapshot fingerprint and
selected generation. It contains no `replicaId`, lock, watcher cursor, pending
cause or secret. A graph move retains identity and is rebound only after
canonical containment checks. A copied graph presents the same `graphId` at a
second root; default behavior is refusal until the user explicitly chooses
**same lineage/new replica** or **new graph lineage**. No path, inode or matching
text makes that choice automatically.

A usable backup must preserve note files and this sidecar from one accepted
point. App-local operational state is separately backed up only as recovery
evidence. Restoring sidecar and files from different accepted transactions is a
mismatch requiring review, not automatic enrollment. If app-local recovery
state is lost while files differ from the accepted sidecar, sync remains
disabled until retained history or explicit review establishes a new accepted
state.

## Authoritative state and restart

The last **accepted sidecar** is authoritative for portable file identity. Live
working bytes are authoritative for what the user currently has, but cannot by
themselves prove an accepted revision. Immutable generations are retained
history and intended plan results. `CURRENT` selects history for participating
prototype readers; it does not prove that the stable working folder or OG's
database accepted that generation. Snapshot-state JSON records revisions and
operations, while the sidecar records which real file ID/path/hash mapping was
accepted. Neither substitutes for the other.

Before generation staging, persist one versioned app-local `ACTIVE` envelope
containing `graphId`, `replicaId`, exact source snapshot, issued preview, target,
authoritative plan and projected snapshot, proposed identity sidecar bytes,
basis/target generations, ordered operation IDs and the working journal
identity. Its transaction ID is deterministic from those canonical inputs. One
active transaction per graph/replica blocks every incompatible new batch.
Incomplete staging remains preserved and refused unless it matches that exact
envelope.

On restart, the app-local index identifies the exact active transaction; it
does not depend on the old process's preview object and does not scan arbitrary
graphs. Recovery first verifies the selected graph's canonical root and
graph-local `graphId`, then the exact envelope, working journal, sidecar and
generation. An exact retry may continue. Any other transaction, corrupt record,
unknown staging, third working-file state or changed graph binding blocks sync
and preserves evidence.

`CURRENT = target` with the sidecar still at the basis means **history
published, working acceptance incomplete**. Recovery applies the documented
per-file before/after/third-state rule. It never rolls back over a possible user
edit. An incompatible target cannot start until files, OG reconciliation,
sidecar and the app-local snapshot checkpoint all agree or the user explicitly
abandons the transaction through a later reviewed recovery design.

## Exact capture, plan and acceptance handoff

1. Load and cross-check the accepted sidecar, accepted snapshot checkpoint and
   stable working bytes. A mismatch is review/recovery, not capture input.
2. Completed local observations enter the accepted pure capture module. A
   wholly eligible target enters comparison; its exposed plan alone owns new
   executable revision IDs.
3. Execute that exact plan in memory. Persist `ACTIVE` with the resulting
   projected snapshot and sidecar bytes derived from the same result. Persisting
   snapshot JSON here is only intent; it proves neither working-file application
   nor identity acceptance.
4. Publish/retain the immutable generation, then use preconditioned per-file
   application and recovery at the unchanged graph path. Partial visibility is
   explicit.
5. Verify all working paths/bytes and reconcile them into OG exactly once. If
   reconciliation fails or a different watcher observation arrives, retain
   `FILES_APPLIED/RECONCILE_PENDING`, block new batches and keep the old sidecar.
6. Write and verify the proposed graph-local sidecar, then persist the matching
   app-local snapshot checkpoint. Cross-directory writes are not atomic; the
   envelope records `IDENTITY_ACCEPTED` so restart can verify either ordering.
7. Acknowledge and clear `ACTIVE` only after files, OG reconciliation, sidecar,
   snapshot checkpoint, generation and journal all match the transaction.

## Feature-gated OG source seams

The integration adapter is absent unless a new build-time/runtime experimental
flag is explicitly enabled. With the flag off, every hook is a synchronous
no-op returning the existing value; it adds no waits, writes, channels,
watcher suppression or error handling. Removing the adapter and hook calls
restores the prior source shape.

- **Save:** editor transactions enter the queued writer at
  [pipeline.cljs](../src/main/frontend/modules/outliner/pipeline.cljs#L12-L15)
  and [file.cljs](../src/main/frontend/modules/outliner/file.cljs#L46-L117).
  Existing `*writes-finished?` describes queue flushing, not confirmed disk
  bytes. At `write-file-impl!`, register a pending cause immediately before the
  IPC `writeFile`; emit completion only after IPC success and database
  content/mtime update, or failure from the existing catch path
  ([node.cljs](../src/main/frontend/fs/node.cljs#L21-L66)). Incoming application
  for that file waits or refuses while this registry contains an unfinished OG
  write; it never assumes the queue is quiet.
- **Rename:** add a cause ID to the exact old/new-path intent in
  `rename-file!`, and emit success only after `fs/rename!` resolves; emit failure
  from the existing catch without changing its current DB/filesystem behavior
  ([page.cljs](../src/main/frontend/handler/page.cljs#L201-L227),
  [state.cljs](../src/main/frontend/state.cljs#L2190-L2198)). The current hosted
  sync channel offers intent before completion and suppresses paths for three
  seconds, so it is not reused as identity evidence
  ([sync.cljs](../src/main/frontend/fs/sync.cljs#L1927-L1981)).
- **Watcher/incoming reconciliation:** Electron emits type, path, content and
  stat after `awaitWriteFinish`, with delayed unlink observation
  ([fs_watcher.cljs](../src/electron/electron/fs_watcher.cljs#L49-L75),
  [fs_watcher.cljs](../src/electron/electron/fs_watcher.cljs#L76-L122)). Extract
  a small callable boundary beside `handle-add-and-change!` so an incoming exact
  cause can request the existing `from-disk? true` reconciliation once; ordinary
  watcher events continue through `handle-changed!` unchanged
  ([watcher_handler.cljs](../src/main/frontend/fs/watcher_handler.cljs#L44-L110)).

## Real watcher matching

Real watcher events have no operation ID. Retain expected causes in `ACTIVE`
before each incoming mutation: transaction/action index, file ID, kind, exact
old/new paths, expected presence pair and complete after-content hash. Time and
inode are diagnostic only.

For an observation, resolve its path against the accepted/proposed identity,
perform the bounded stable reread required by capture, and compare the complete
observed state with outstanding causes. Rename requires the paired old-path
absence and new-path bytes; delete requires exact old-path absence after its
retained recovery move. Only one unique full match inherits that cause's
operation ID. Zero or multiple matches remain ordinary/pending observations.

The first exact incoming observation triggers OG reconciliation once. Only
after reconciliation success may repeated exact observations be classified as
echoes. Any different content, presence, path, identity or operation phase is a
new edit and enters capture/review, even inside a time window. This differs from
the synthetic classifier, whose controlled event already carries the operation
ID and complete tuple.

## Smallest next implementation slice

Add one removable `frontend.fs.og-sync-bridge` behind a default-off experimental
flag. It contains only typed hook calls and a pure/injected adapter interface:
save pending/completion/failure, rename intent/completion/failure, raw watcher
observation, incoming reconciliation request/result, and `ACTIVE` envelope
recovery. Use an in-memory fake operational store, fake filesystem port and
synthetic event source. Do not create the sidecar, touch a graph, call the native
publisher/helper, or enable the flag in any package.

Focused acceptance tests:

- flag off preserves save/rename promise results, ordering, errors and watcher
  behavior and produces zero adapter calls;
- save completion cannot precede IPC success, queue-flush state is insufficient,
  and an unfinished write blocks an incoming action for that file;
- rename intent alone changes no identity; success/failure closes the exact
  cause without path-time suppression;
- exact watcher tuple reconciles once and later duplicates are echoes, while a
  different edit follows the existing watcher path;
- serialized `ACTIVE` reconstructs the exact preview/plan/cause after simulated
  restart, blocks incompatible batches, and refuses corrupt or unknown staging;
- snapshot checkpoint without matching proposed sidecar/files never reaches
  identity acceptance.

This slice proves source-seam placement, disabled equivalence and restartable
coordination with synthetic ports. It does not apply a real file, prove watcher
stability, establish power-loss durability or make OG usable for sync.

## Limits and approval decisions

Uncooperative writers remain outside the lock; checks do not eliminate
check/write races. Multi-file application can remain partially visible.
Incomplete staging and third states fail closed. Injected failures do not prove
power-loss durability.

Before the next slice, the user must approve the default-off OG hook additions,
although they perform no real I/O while disabled. Before any real enrollment,
the user must separately approve (1) the recommended graph-local
`logseq/.og-sync/identity-v1.json` format and backup implications, and (2) the
explicit copied-graph choice between same lineage/new replica and new lineage.
Real sidecar creation, native application and enabled preview remain separate
future approvals.
