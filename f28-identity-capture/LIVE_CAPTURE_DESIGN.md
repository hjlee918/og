# Live OG save/rename capture into persistent identity records

Status: design for the approved single-machine integration batch, written before
any filesystem or application work in this stage. It connects **actual completed
OG saves and renames** on one fresh synthetic graph to the already-validated
persistent file-identity and recovery records
([PERSISTENT_IDENTITY_DESIGN.md](../f28-sync-prototype/PERSISTENT_IDENTITY_DESIGN.md)).

This is **local capture only**. OG remains the sole writer of the test notes.
The adapter writes only its approved sidecar and device/recovery records. No
completed OG edit is reapplied as an incoming write. There is no cross-device
transport, no incoming application, no synchronization, and nothing here is
enabled in any normal or existing package.

## Approved goal and prior state

The three preceding stages established, separately:

1. the default-off OG bridge seams and the pure capture/comparison/identity
   modules, verified end to end against each other with synthetic ports
   ([OG_INTEGRATION_DESIGN.md](../f28-sync-prototype/OG_INTEGRATION_DESIGN.md));
2. the two-root persistent identity/recovery store with its anchored helper,
   validated standalone ([RESULTS.md](../f28-sync-prototype/RESULTS.md));
3. live observation: a packaged experimental OG build recording real
   save/rename causes bound to the operated graph
   ([f28-observation/README.md](../f28-observation/README.md)).

What did not exist before this stage is the connection: real completed OG
operations producing matching **accepted** persistent records. This design adds
that connection without adding application authority.

## Process boundary and network control

The experimental network control
([NETWORK_CONTROL.md](../f28-origin/NETWORK_CONTROL.md)) refuses generic
process launches **inside the packaged application**, and that protection is not
disabled or weakened. The native helper therefore cannot be invoked by the app,
and no new privileged IPC interface, process-launch exception, access root or
helper-execution path is added for it.

Instead, an **external test-owned coordinator** — a plain Node process started
by the operator, outside the application — connects the two already-approved
halves:

- it reads the observation runtime's already-sanitized in-memory event stream
  through the existing read-only `__LOGSEQ_OG_BRIDGE_OBSERVATION__` page API
  (the exact reader the live-observation stage verified);
- it invokes the existing anchored `identity_store_helper` for every graph-byte
  read and every record write.

The application build used here is a **new, separately packaged experimental
build** (`Logseq OG F28 IdentityCapture`), compiled from the same source and the
same closure defines as the verified observation build. Its in-app bridge
runtime is exactly the established observation-only runtime: no persistence
port, no synchronization port, no sidecar write, no helper execution, no
renderer filesystem access beyond OG's own existing behavior. It never replaces,
launches, signals or alters installed OG, the OriginExp package, the Observation
package or any existing profile; it has its own fresh profile root and leaves
every ownership lease untouched.

## Exact data flow

For one accepted capture (a completed save; a rename follows the same shape):

```
OG renderer/editor                    external coordinator               anchored helper
----------------------               ----------------------              ---------------
UI edit -> outliner transaction
  -> write-plain-text-file!  ---(save-pending cause: graph-id, path,
                                content-hash, status)-->
  -> node backend writeFile IPC
  -> DB content/mtime update
  -> save-completed cause --->
                                      1. group all save causes for the exact
                                         graph-id + path by content-hash;
                                         require every cause in the group to be
                                         completed (nested/overlapping hooks
                                         collapse to ONE logical save; a still
                                         pending or failed cause is not
                                         completion evidence)
                                      2. read the note through the helper --->
                                                                      anchored, non-following
                                                                      open under the owned run
                                      3. read it AGAIN and require byte-identical
                                         results, and require
                                         sha256(bytes) == cause content-hash
                                         (unstable or mismatched read => the
                                         operation stays PENDING; nothing is
                                         accepted)
                                      4. build capture observations
                                         (save-complete + stable-read) and run
                                         the existing captureChanges ->
                                         comparison -> executor path, deriving
                                         proposed metadata from the executed
                                         comparison plan, never from the cause
                                      5. updateIdentity with the proposed
                                         revisions and the exact disk bytes --->
                                                                      intent first, then
                                                                      sidecar, then device
                                                                      record (graph-first),
                                                                      then clear
                                      6. openGraph and require the accepted
                                         sidecar, device record, snapshot
                                         fingerprint and disk bytes to agree
                                         exactly with what capture proposed
```

Nothing in this flow writes a note. The only graph-tree writes are
`logseq/.og-sync/` records; the only profile-tree writes are device records,
intents and retained evidence. The coordinator never issues `put-note` against
the live graph.

## Owned paths

Exactly two anchored roots, both sent byte-for-byte by the caller and compiled
into the helper:

```
GRAPH_ROOT   /Users/johnlee/Library/Mobile Documents/com~apple~CloudDocs/Logseq Test
PROFILE_ROOT /Users/johnlee/Library/Application Support/Logseq OG F28 IdentityExp
```

One fresh, uniquely named, explicitly owned run, created by the helper's `init`
before any application launch:

```
<GRAPH_ROOT>/<runName>/OWNER                 "<ownerToken>\n"   (64 hex + newline)
<GRAPH_ROOT>/<runName>/graph/                the live synthetic OG graph
  pages/*.md                                 OG writes these; the adapter never does
  logseq/.og-sync/OWNER                      adapter-owned, hidden from OG
  logseq/.og-sync/identity-v1.json           portable sidecar
<PROFILE_ROOT>/<runName>/OWNER               "<ownerToken>\n"
<PROFILE_ROOT>/<runName>/identity-state/     device-local records
  OWNER, LOCK, device.json, intent-<tx>.json, evidence/uncertain-<tx>.json
```

The application's own profile is a **separate** fresh root,
`~/Library/Application Support/Logseq OG F28 IdentityCapture/identity-capture-state`,
established and restored by the existing fresh-profile swap tooling. It is not
inside either anchored root, so no application file can ever appear in an owned
identity run and no identity record can appear in the application profile.

Neither shared root is enumerated. Previous runs, their graphs, their profiles
and their evidence are preserved untouched.

## Completion, stability and pending semantics

- **Completion evidence** is a cause with `status: completed`, which the bridge
  emits only after the existing write path's IPC success and database updates.
  A pending cause — intent or queue flushing — is never completion.
- **Overlapping/nested hooks**: one logical desktop save passes through the
  filesystem dispatch seam and the node backend seam, producing two cause pairs
  with the same graph-id, path and content-hash. The coordinator groups causes
  by that exact tuple and requires every cause in the group to be completed
  before treating the group as one completed save. Operation identity is never
  inferred from elapsed time.
- **Stable read-back**: before any metadata acceptance the coordinator reads the
  exact note through the anchored helper twice and requires identical bytes
  whose SHA-256 equals the cause's content-hash. For a rename it additionally
  requires the old path to read absent twice. An unstable read, a mismatched
  read, or a later edit that advanced the bytes leaves the operation **pending**
  — it is recorded as not-captured evidence and is never falsely accepted. The
  next capture batch derives from the bytes actually on disk.
- **Re-feeding completed evidence** after acceptance is refused by the capture
  module (`save-evidence-mismatch`); it never creates a second revision.
- Duplicate observation records fed into one capture batch are idempotent: the
  capture module's content-bound observation IDs collapse them, and one
  completed save yields exactly one revision in the accepted record.

## Record persistence and failure behavior

Record publication is the existing two-tree ordering: intent first, then
sidecar and device record in the recorded order, then a separately-failing
clear. Cross-directory atomicity does not exist and is not claimed. A failure
after staging leaves the durable outcome unknown (`uncertain-write`), retains
the intent and every pending file, and reserves the exact transaction: the
validated continuation is recovery of that outstanding transaction, which
classifies from the bytes actually on disk and rolls forward only the remaining
write of the same transaction. Where the failed step leaves the base record
untouched (enrollment, or the first step of an update), the identical re-issue
recomputes the identical transaction ID and continues through that recovery; a
re-issue is never a second write. Where the failed step is the second record of
an update (graph-first device step), the sidecar already names the target, so
the store refuses the re-issue (`stale-metadata-revision`) rather than
re-deriving over it, and recovery of the outstanding transaction is the only
continuation.

**OG's results are never affected.** A capture or persistence failure stops
capture only: the note OG saved stays saved, its bytes are re-read and asserted
unchanged after the failure, and no experimental path reports an OG save as
failed, erases a note, or alters an OG error. The injected failure used in this
batch is a record-persistence failure only (`FAILURE after-stage` at the device
step, graph-first ordering): the sidecar reaches its target, the device record
stays at base, and recovery classifies `graph-applied` and completes the device
write.

## Restart

Quitting and reopening the application must not disturb identity. The
coordinator verifies after the safe quit — with no application running — that
`openGraph` still classifies `accepted`, the accepted snapshot fingerprint and
metadata revision are unchanged, and the note bytes are unchanged; after the
reopen it verifies the exact saved contents render and the accepted records
still agree. The device record's graph and profile bindings (run, directory,
device, inode) are revalidated on every open, so a moved or copied run refuses
rather than being silently rebound.

## Limits

This is one host, one fresh synthetic graph, one coherent batch. The
cooperative lock serializes participating helper invocations only — OG, Finder
and cloud agents do not honour it, and end-to-end serialization of two
concurrent coordinator processes is not tested. Anchored non-following opens and
entry re-verification refuse the substitutions visible at those checks; they
are not an OS sandbox and do not close the ancestor-relocation race. Injected
failures establish recovery classification, not power-loss durability; no real
power-loss or simultaneous-host test is run. Watcher-based incoming matching
remains synthetic-only: this stage captures completed local operations through
causes and never applies an incoming change. Nothing here is usable
cross-device synchronization, and no transport, incoming application,
real-data enrollment or release follows from it.