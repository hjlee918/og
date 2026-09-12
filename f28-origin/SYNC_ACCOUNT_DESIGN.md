# Cross-device synchronization and account decision

Status: proposed architecture, not finally adopted. Updated 2026-09-11 after
the approved limited local prototype. No hosted service, account connection,
migration, deployment or release is authorized.

## Proposed decision

Use a **project-controlled, application-aware version protocol with an ordinary
local OG graph on every installed device**. Reuse OG's file serialization,
watcher/reconciliation boundaries, transaction concepts, version UI and selected
merge utilities after focused review. Do not make Logseq's hosted service,
Syncthing, iCloud or another shared folder the product's source of truth.

Start with a local, deterministic two-replica prototype. It should prove file
identity, version preconditions, conflicts, interrupted transfers and recovery
before choosing an account vendor or creating a hosted service. Automerge is a
reasonable later component to evaluate for structured concurrent state, but it
is not required for the first prototype and is not a complete account,
encryption or OG-file reconciliation solution by itself.

## Verified project facts

The current F27/F28 package is an experimental reference-feature preview, not
full MVP-A acceptance. Intel demonstrated the standalone offline launcher and
local Dracula/Readwise UI. The arm64 run demonstrated its narrower package from
source `87b811663`. Readwise authenticated sync was not tested; Ollama and
ChatGPT compatibility failures remain open; iOS, Android, Windows and browser
acceptance have not begun. One startup `ERR_BLOCKED_BY_CLIENT` remains an
unexplained strict failure. This design does not reopen those validation areas.
The preview's pre-navigation network refusal also blocks its native sync paths;
this design does not relax that control or turn the offline preview into a sync
client.

OG already provides useful integration seams:

- Current graph identity is stored and propagated to Electron in
  [`state.cljs` lines 790-855](../src/main/frontend/state.cljs#L790); remote sync
  identity is a separate graph UUID at
  [`state.cljs` lines 2134-2144](../src/main/frontend/state.cljs#L2134).
- Editor transactions call the outliner file pipeline, which batches and writes
  ordinary page files in
  [`pipeline.cljs` lines 85-120](../src/main/frontend/modules/outliner/pipeline.cljs#L85)
  and [`file.cljs` lines 46-117](../src/main/frontend/modules/outliner/file.cljs#L46).
  The central `alter-file` path distinguishes application writes from disk
  reconciliation in
  [`handler/file.cljs` lines 111-196](../src/main/frontend/handler/file.cljs#L111).
- Electron's chokidar wrapper emits add/change/unlink events and closes watchers
  on quit; the guarded build also rejects child-path and symlink escape before
  content access in
  [`fs_watcher.cljs` lines 49-95](../src/electron/electron/fs_watcher.cljs#L49)
  and [`fs_watcher.cljs` lines 139-196](../src/electron/electron/fs_watcher.cljs#L139).
  Renderer reconciliation makes a backup before changed disk content is parsed
  and handles deletion and local CSS in
  [`watcher_handler.cljs` lines 28-137](../src/main/frontend/fs/watcher_handler.cljs#L28).
- The dormant OG sync client records graph/transaction IDs, checksums and local
  version files, and describes periodic local/remote reconciliation in
  [`fs/sync.cljs` lines 44-123](../src/main/frontend/fs/sync.cljs#L44). It models
  rename, update and delete transactions and optional three-way merge in
  [`fs/sync.cljs` lines 1572-1741](../src/main/frontend/fs/sync.cljs#L1572), plus
  pause/resume and reconnect state in
  [`fs/sync.cljs` lines 2961-3202](../src/main/frontend/fs/sync.cljs#L2961).
- The client has passphrase/public/private-key handling in
  [`fs/sync.cljs` lines 1983-2174](../src/main/frontend/fs/sync.cljs#L1983), but
  its account, API and WebSocket endpoints are hard-coded to Logseq-operated
  Cognito and service domains in
  [`config.cljs` lines 30-62](../src/main/frontend/config.cljs#L30). Native file
  operations are wrappers around `@logseq/rsapi` in
  [`file_sync_rsapi.cljs` lines 1-57](../src/electron/electron/file_sync_rsapi.cljs#L1).
  The checked package declares that client module MIT, while this application is
  AGPL-3.0 ([`static/package.json` lines 1-16](../static/package.json#L1)). No
  corresponding legacy file-sync server was found in this checkout.
- OG persists an `id` property when a block is referenced, rather than proving
  that every block has a durable ID in every file
  ([`modules/file/core.cljs` lines 34-89](../src/main/frontend/modules/file/core.cljs#L34)).
  External-file reconciliation attempts to retain UUIDs by structural diff and
  adds missing IDs for referenced blocks
  ([`watcher_handler.cljs` lines 28-56](../src/main/frontend/fs/watcher_handler.cljs#L28)).
  A future protocol therefore cannot assume every in-memory UUID is already a
  portable cross-device identity.

The current upstream Logseq repository now publishes a self-hostable **DB graph**
sync server, but its own documentation describes SQLite snapshots and DB graph
storage. That is useful research, not evidence that it is compatible with this
fork's Markdown/Org file graphs
([official DB-sync server README](https://github.com/logseq/logseq/blob/master/deps/db-sync/README.md)).
The official legacy file-sync guide still warns that the service was beta,
could lose data, did not support simultaneous collaboration, and should not be
combined with a cloud-synced folder
([official Logseq Sync guide](https://blog.logseq.com/how-to-setup-and-use-logseq-sync/)).

## Three approaches

| Approach | Reuse and reach | Reliability, license and burden | Decision |
|---|---|---|---|
| Logseq-hosted legacy file Sync | Reuses most dormant OG client/UI code and historically covered desktop, iOS and Android. | The client is present, but service access, fork eligibility, backend implementation and long-term compatibility are not granted by its source license. The official guide retains beta/data-loss warnings. Current upstream's open server is for DB graphs. Lowest initial engineering only if Logseq explicitly supports this fork; highest external dependency. | Keep as a possible negotiated service, not the foundation. |
| Provider folder or peer sync (iCloud, Dropbox, OneDrive, Syncthing) | Preserves normal files and is cheap on desktop. Syncthing is an MPL-2.0 continuous file synchronizer ([official repository](https://github.com/syncthing/syncthing)). | It observes files, not OG transactions or block identity, so concurrent writes can still create stale/conflicting files. It cannot supply the required account, conflict review and application history. Syncthing officially has no planned iOS client and cites iOS background restrictions ([official FAQ](https://docs.syncthing.net/users/faq.html#is-there-an-ios-client)). | Optional backup/export transport only. Never call shared-folder availability real-time or conflict-safe sync. |
| Project-controlled application-aware version protocol | Reuses OG's local files, watcher/write boundary, file transactions, version concepts and UI while serving macOS, iOS, Android, Windows and later browser through thin adapters. | Highest engineering and security responsibility. Service costs include identity, metadata DB, encrypted object versions/attachments, egress, push, monitoring, backups and incident response. The protocol can remain host-portable and later self-hostable. Automerge is MIT and supplies CRDT/sync primitives, storage and network adapters, but its own docs say application plumbing remains ([project](https://github.com/automerge/automerge), [Repo docs](https://automerge.org/docs/reference/repositories/)). | **Recommended**, beginning locally without a service. |

For the initial single-user scale, stored note bytes should be modest; attachment
history, egress, identity-provider minimums and operational support are the cost
drivers. A managed metadata/object platform is the smallest hosted pilot.
Self-hosting would add deployment, upgrade, backup and troubleshooting work, but
this design does not estimate that effort without a selected stack and operating
model. Exact prices should be compared only after retention and account-provider
choices are approved.

## Proposed protocol behavior

These are proposals, not implemented facts.

**Local files and reconciliation.** Each device edits a normal UTF-8 Markdown/Org
graph offline. Enrolling an existing graph first creates app-owned, exportable
sidecar state without rewriting graph content. That durable sidecar keeps graph
ID, device ID, immutable file ID,
exact display path, normalized collision key, content hash, parent revision,
operation ID and acknowledgement cursor. Received changes are staged, verified,
then applied atomically through the same file/write-watcher reconciliation path
that OG can parse and index. Disabling sync leaves ordinary files and assets.
Plugin/profile settings are excluded initially; desktop plugins continue against
local files, while Electron-only plugins are not promised on mobile or web.

**Identity, rename and Unicode.** File identity is independent of its path.
Rename is one operation on that ID; delete is a tombstone, never inferred from a
missing download. Preserve exact UTF-8 names and text for display. Use NFC plus a
documented case/normalization collision key to detect names that macOS NFD,
Windows casing, or another platform could alias; surface the collision and never
rename or merge it silently. Persisted OG block `id` values are authoritative.
For blocks without one, the prototype carries IDs in the version sidecar and
uses parser structure only to propose a match. Ambiguity creates a conflict. If
that proves too fragile, writing OG-compatible IDs to every block becomes a
separate compatibility decision, not a hidden migration.

**Concurrency and recovery.** Every mutation names its parent revision and is
idempotent. A server or local relay accepts a new head only when the parent still
matches. Divergent update/update, edit/delete, rename/rename and normalization
collision cases retain both immutable branches. A parser-aware three-way merge
may be offered only when it is deterministic and validates; otherwise the user
gets a conflict preview. There is no silent last-writer-wins. History retains
content versions, tombstones and device attribution under an explicit retention
policy; restore creates a new revision instead of erasing later history.

**Attachments and reconnect.** Attachments use content-addressed, encrypted
chunks with resumable upload/download, per-chunk and final hashes, temporary
staging and atomic placement. Retries use operation IDs, so interruption cannot
double-apply a change. Reconnect first exchanges cursors/manifests, fills missing
versions and attachments, validates them, then advances the acknowledgement.
Push/WebSocket messages are wake-up hints; the version log remains authoritative.

**Account, devices and keys.** OAuth/OIDC login proves account identity and
authorizes access to encrypted objects; it does not decrypt a graph. Each device
generates its own key pair. An already approved device or an offline recovery
code wraps the graph key for a new device. Revocation stops future access and
triggers forward key rotation; it cannot erase data a formerly approved device
already decrypted. Tokens and keys live in Keychain/Keystore or equivalent
platform storage, never in graph files. The recommended recovery model is a
user-held recovery code with approved-device recovery and no server plaintext
key escrow.

**Mobile and later platforms.** Foreground clients can synchronize promptly,
but suspended phones cannot promise immediate updates. iOS can continue suitable
background URLSession transfers, yet force-quitting cancels them and requires a
manual relaunch ([Apple documentation](https://developer.apple.com/documentation/foundation/urlsessionconfiguration/background(withidentifier:))).
Android should use persistent WorkManager jobs with OS-controlled scheduling
([Android documentation](https://developer.android.com/develop/background-work/background-tasks/persistent)).
Both mobile apps must catch up on open and clearly show pending/stale/conflict
state. macOS Intel/Apple Silicon come first with iOS; Android follows. Windows
uses the same protocol and filesystem adapter. A later browser client uses the
same identities, encrypted history and conflict rules with a browser cache and
export; desktop filesystem access and native plugins are not assumed there.

## Implemented limited local prototype

The approved first batch is implemented as the standalone
[`f28-sync-prototype`](../f28-sync-prototype/README.md) Node module and test
harness. It is not imported by OG or included in an application package. Its
pure transition core models whole-file create, update, rename, delete and
restore using caller-supplied synthetic file/revision/operation IDs. It retains
stale-parent branches and tombstones, rejects changed operation-ID reuse, and
records NFC/NFD path collisions. Its local JSON persistence adapter simulates
two replicas and a relay inside one fresh, canonically contained test-owned run.

This local simulation demonstrates deterministic state transitions and
controlled persistence/retry ordering. It is not real-device synchronization,
an OG watcher integration, a network protocol, a security boundary, or evidence
of power-loss durability. Accounts, encryption, networking, hosted services,
attachment transfer, block matching, parser-aware merge, mobile adapters,
existing-graph enrollment and UI remain deferred. Real platform acceptance will
still require separate real-device work after architecture review.

The next approved slices implemented the pure reconciliation planner and a
small in-memory executor in
[`f28-sync-prototype`](../f28-sync-prototype/README.md). Given an explicit
snapshot and explicit synthetic file events, it now produces a deterministic
reviewable plan, blocks existing multi-head/relevant-conflict cases, recomputes
and validates that plan, and applies an eligible whole batch to a private state
clone. It distinguishes exact retry from stale destination and exposes no
partial state on failure. It does not read or write files, discover changes,
integrate with OG, or reserve a destination. Any filesystem executor remains a
separate future decision and needs an anchored directory boundary plus an
atomic precondition check.

## Decisions needed from the user

No choice is needed before the local prototype. Before any hosted pilot, approve:

1. **Service/cost:** recommended staged project-hosted managed service first,
   with protocol export and self-hosting kept possible. Choosing first-day
   self-hosting lowers vendor dependence but materially increases setup and
   support burden.
2. **Account providers:** recommended managed OIDC with Sign in with Apple plus
   Google, and an email recovery/contact path. Provider terms, recurring cost
   and account-linking behavior require approval before integration.
3. **Key recovery:** recommended approved-device transfer plus a user-held
   recovery code, with no server key escrow. The tradeoff is honest: losing all
   approved devices and the recovery code makes encrypted remote history
   unrecoverable. Server escrow would improve account recovery but weaken the
   end-to-end-encryption promise.

The earlier dedicated Roam-import task is cancelled by user decision. OG's
existing importer and historical records remain preserved. No replacement
importer work or dedicated importer testing is planned, and the isolated
launcher's existing import refusal remains unchanged.
