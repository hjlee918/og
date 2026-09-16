# Incoming change application design

Status: **approved, implemented, and corrected after supervisor review**,
2026-09-16. Three findings from that review are fixed and the contracts they
touched are restated below; see "Supervisor review corrections" at the end and
RESULTS.md for what was actually reproduced and verified.

Status: approved and implemented, 2026-09-15. The user approved the first
slice; the ambiguities the review raised were resolved in this document before
implementation, and the sections below describe what was built, not what was
proposed. Results are recorded in
[RESULTS.md](./RESULTS.md), section "Incoming change application (2026-09-15)".

It designs how a change that did not originate from this device's OG is applied
to an enrolled test graph **without silently overwriting a newer local edit**,
reusing the existing capture, comparison, identity-store and observation
components. It introduces no second sync engine.

Every prior stage kept OG as the sole writer of note files. This slice ends
that, for one experiment, inside the existing anchored roots — the single
largest authority change in the project so far, and the first item the user
approved.

## What this is not

- Not whole-graph atomicity. Application is per file; an interruption leaves a
  mixed, explicitly recorded intermediate state.
- Not protection from arbitrary external writers. OG, Finder, cloud agents and
  external editors do not honour the helper's cooperative lock.
- Not cross-process serialization. Two concurrent coordinator processes have
  never been demonstrated to serialize end to end, and nothing here demonstrates
  it.
- Not power-loss durability. Injected failures establish recovery
  classification only.
- Not cross-device transport. The "remote" replica is a synthetic state
  constructed in the same process on the same host; no network, account or
  service is contacted, and a simulated replica input proves nothing about a
  real second device.

## Components reused, unchanged

| Component | Role here |
|---|---|
| `src/snapshot-comparison.js` `compareSnapshots` | Sole owner of the executable plan and its revision IDs. The applier recomputes the plan and refuses a proposal whose plan it does not reproduce. |
| `src/executor.js` `executePlan` | Projects the target state in memory from that recomputed plan. |
| `src/identity-capture.js` `captureChanges`, `enrollIdentityMetadata`, `validateMetadata` | Collision keys, tombstones, review decisions, metadata derivation and validation. |
| `src/persistent-identity.js` `openGraph`, `snapshotFromDisk`, `updateIdentity`, `publish`, `recover`, `readNote`, `hashGraphNotes`, `transactionFor` | Record reading, two-tree publication, recovery classification. |
| `native/identity_store_helper.c` `put-note`, `read-note`, `hash-graph`, `write-record`, `clear-intent` | Every graph-byte read and every write, under the anchored roots and the cooperative lock. |
| `f28-identity-capture/checks/run-identity-capture.js` shape | The external operator-started coordinator pattern. The app gains nothing. |
| `frontend.fs.og-sync-bridge` observation runtime | Pending-local-write evidence and observer health, read-only, exactly as today. |

Nothing above is modified except one hardcoded value and — subject to approval —
one added command pair, both named in [§7](#7-process-ownership-and-locking) and
in the approval list.

---

## 1. Incoming proposal identity and accepted base revisions

An incoming change arrives as one complete record, never as a stream of diffs.

```
schema                        "f28-incoming-proposal/1"
proposalId                    64 hex, a digest over every field below
graphId                       must equal the local accepted sidecar's graphId
base.metadataRevision         the exact accepted revision it was computed against
base.snapshotFingerprint      "sha256:<64 hex>"
base.acceptedTransactionId    64 hex
originReplicaId               device-local provenance; never reaches the sidecar
plan                          the proposer's comparison plan, as produced by compareSnapshots
files[]                       fileId, basePath, baseContentHash | "absent",
                              targetPath, targetContentHash, targetContent,
                              revisionId, parentRevisionId
projectedSnapshotFingerprint  what the proposer says the result will be
```

`proposalId` is deterministic over those canonical inputs, so an identical
resubmission is the same proposal and never a second one — the same property
`transactionFor` already gives the identity store.

**Accepted base is exact.** The applier reads the local records with
`openGraph` and requires `accepted`. It then requires all three of
`base.metadataRevision`, `base.snapshotFingerprint` and
`base.acceptedTransactionId` to equal the local accepted sidecar's values.
Any other base is refused `unknown-base`. A proposal is **never** rebased onto a
different accepted state in this slice: the proposer recomputes it, or it is
discarded.

**The proposal never names revisions on its own authority.** It cannot even
express one: `acceptedRevision` is not a field of `f28-incoming-proposal/1`. The
applier reconstructs the source snapshot from the accepted sidecar, reconstructs
the proposer's target state, and recomputes the plan with `compareSnapshots`. If
the recomputed plan is not byte-identical to `plan`, the proposal is refused
`plan-mismatch` and nothing is written. The revision each file is **stored**
under is then taken from that executed plan's action for that file — a
deterministic `compare-revision-<32 hex>` — and files the plan does not touch
keep the revision the accepted sidecar already names. This is the
`:revalidate-plan!` discipline the end-to-end adapter already verifies; it is not
weakened here.

**The proposal's identity is recomputed, not trusted.** `proposalId` is a digest
over the proposal's whole canonical body. It is recomputed on every read and a
mismatch refuses `proposal-identity-mismatch`, so a changed body cannot keep a
previously valid identity — and therefore cannot produce a previously valid
approval fingerprint. `planId` must match `plan-[0-9a-f]{32}` exactly; every
identifier, revision label and fingerprint is type- and shape-checked.

**Per-file identity rules.** A `fileId` already tombstoned locally is refused
`tombstoned-file`. A `fileId` unknown locally is admissible only as a create. An
NFC-plus-conservative-case-fold collision across existing and proposed paths is
refused `collision`; nothing is normalized, merged or renamed to resolve it.

**The two synthetic replica states.** Replica A is the real enrolled graph on
this host, at its accepted sidecar. Replica B is an in-memory state the
coordinator constructs from replica A's accepted snapshot plus scripted edits.
There is no second graph directory and no second device. The "transport" is one
JSON file the coordinator writes and reads back inside its own owned profile
run. Calling B a replica is a naming convenience for the experiment; it
establishes nothing about a real peer.

## 2. Detection of pending saves, newer local edits and conflicts

Three checks, in this order, before any mutation. Each refuses the **whole**
proposal; there is no partial acceptance of a proposal.

### (a) Pending local saves

A pending or failed cause is never completion evidence, and a pending local
write must never be raced by an incoming write.

- The bridge's existing `unfinished-local-write?` answers this for the
  participating OG runtime: any `:pending :local` save or rename cause in that
  graph whose path set intersects the proposal's paths blocks the proposal
  (`unfinished-local-write`).
- In the recommended app-closed slice the coordinator additionally requires, at
  quit time, that the observation stream holds no pending local cause and that
  the app quit cleanly, and it records that condition in the preview. It is a
  recorded precondition, not an enforced exclusion.

### (b) Newer local edits

The authoritative comparison is **disk bytes against the accepted sidecar**,
never a timestamp, never an mtime, never an elapsed-time window.

For every file the proposal touches, plus every file the plan's collision keys
reach, the coordinator performs the same stable read-back capture already uses:
read through the anchored helper **twice**, require byte-identical results, and
hash them.

| Observed | Meaning | Outcome |
|---|---|---|
| disk hash == accepted contentHash | base intact | proceed |
| disk hash != accepted contentHash | an uncaptured local edit is newer than the accepted record | refuse `local-ahead-of-accepted` |
| the two reads differ | the file is being written now | refuse `unstable-read` |
| an update's file is absent | local deletion not yet captured | refuse `missing-base` |
| a create's target path is occupied | not the file the plan expects | refuse `destination-occupied` |

`local-ahead-of-accepted` is the central protection. It is the same state the
live capture batch already produced and named: the store refuses to read a
disk-ahead graph as accepted (`snapshot-mismatch`). The correct continuation is
to capture that local edit first through the existing capture path, which
advances `metadataRevision` — at which point the proposal's base no longer
matches and the proposer must recompute. The incoming path never decides between
a local edit and an incoming one.

`hashGraphNotes` is taken at preview and re-taken immediately before
application. A difference means some note changed in the window, including a
file the proposal does not name; the application refuses `graph-changed`. Its
`extra` count (non-note regular files) is reported separately rather than folded
into a claim about note bytes.

### (c) Conflicts

The only clean case is: proposal base == accepted == disk. Everything else is
one of the typed refusals above. There is no three-way merge, no text merge, no
last-writer-wins and no "newer timestamp wins".

**Two different kinds of refusal, never conflated.** Every refusal returns a
typed code and retains every record, but they do not make the same claim about
the graph:

- **Preflight refusal** — raised before the first note write. `mutated: false`.
  No note byte changed, and the claim that nothing changed is one this code
  actually establishes. All of §1 and §2, the bounds checks, the parent-directory
  proof and the app-closed gate refuse here.
- **Interrupted application** — raised after at least one note write landed.
  `mutated: true`, with the exact list of files already at their target. The
  graph is in a mixed state, that state is named in the result and in the
  journal, and no claim is made that everything is unchanged.

Code that reports a refusal must carry this distinction; "the refusal left
everything unchanged" is only ever said about the first kind.

### The race that remains

The helper rechecks the destination's exact content hash immediately before
`renameat`, under the cooperative lock (`publish_entry`, `EXPECT`). That is a
recheck-then-rename, **not** an atomic compare-and-swap. A writer that does not
honour the lock can change the destination between the recheck and the rename;
the rename then overwrites that change, and the post-rename verification
confirms only that the staged bytes landed, so such an interleaving is not
detected at write time. Checks (b) and (c) above narrow the window; they do not
close it. The preview states this in the words the operator reads.

## 3. Preview and explicit approval before mutation

Two separate coordinator invocations, with an artifact in between. There is no
single command that plans and applies.

**Phase 1 — `plan`.** Writes nothing to the graph tree. It runs `openGraph`,
the stable read-backs, the plan recomputation and all of §2, then emits
`f28-incoming-preview/1` into the owned profile run:

```
schema, proposalId, planId
base       { metadataRevision, snapshotFingerprint, acceptedTransactionId }
target     { metadataRevision, projectedSnapshotFingerprint }
graphNoteHash, graphNoteCount, graphExtraCount
files[]    fileId, kind ("create" | "update"),
           oldPath, newPath (exact UTF-8; Korean preserved byte-for-byte),
           oldContentHash | "absent", newContentHash,
           oldLength, newLength,
           precondition ("absent" | "<64 hex>")
applyOrder  the fileIds in byte order — the exact order §4 will use
limits[]    the sentences from §2 and §7 that this run cannot guarantee
previewFingerprint  "sha256:<64 hex>" over the canonical preview
```

**Phase 2 — `apply --approve <previewFingerprint>`.** The operator must pass the
fingerprint explicitly. Apply recomputes the preview from scratch and refuses
`preview-stale` if the fingerprint differs for any reason. There is no default
approval, no timeout approval, no standing approval across proposals, and no
auto-apply flag.

For an incoming change that capture classifies as requiring review — an external
add or unlink with no matching cause — the existing `captureChanges` review
decision (`decisionId` + `pendingIds` + `metadataRevision` + `action`) is the
approval record, and it is already bound to the exact metadata revision, so a
stale decision is refused by the module rather than by this layer.

## 4. Per-file application, retained before-images, interrupted recovery

### Journal and before-images

Before any note byte is written, the coordinator writes **one** device-local
record at **one fixed name**, `<profileDir>/incoming-journal.json`. There is no
second journal file and no per-file marker file. The earlier draft of this
section proposed a per-proposal filename plus separate marker records; both are
superseded here, because a per-proposal filename cannot be found again after a
restart without listing a directory, and separate markers multiply the records a
restart has to reconcile.

```
schema        "f28-incoming-journal/1"
state         "open" | "closed"
approved      IMMUTABLE after creation — the approved inputs
  proposalId, planId, previewFingerprint
  graphId
  graphBinding    { runName, graphDirectory, graphDevice, graphInode }
  profileBinding  { runName, profileDirectory, profileDevice, profileInode }
  base          { metadataRevision, snapshotFingerprint, acceptedTransactionId }
  target        { metadataRevision, snapshotFingerprint,
                  transactionId, sidecarHash, deviceHash }
  applyOrder    [fileId, ...]  complete, unique, byte-ordered
  files         fileId -> { kind, path, precondition,
                            beforeImage { presence, contentHash, contentHex },
                            targetContentHash, targetContentHex,
                            acceptedRevision }
  unchanged     fileId -> { path, contentHash, acceptedRevision }
approvedHash  "sha256:<64 hex>" over stableStringify(approved)
progress      MUTABLE — what this device believes it has done
  applied         [fileId, ...]
  recordsAccepted boolean
  transactionId   null until the bound transaction is proven accepted
```

**Immutable inputs and mutable progress are separated on purpose.** `approved`
is written once and never edited; `approvedHash` is recomputed and compared on
every read, so an edit to the approved half is detected. `progress` is the only
part a later write may change. `progress` is a *claim*, never proof: on restart
the bytes on disk decide what was applied, and `progress.applied` is used only
to cross-check that conclusion and to report a disagreement.

`beforeImage.contentHex` and `targetContentHex` are exact bytes in hex, so no
string decoding sits between the journal and the file. They live only in the
profile tree — device-local, never in the sidecar, never portable.

**The journal slot is the transaction lock, and it is never reused.** Creation
writes with the precondition `absent` and nothing else. A journal that is
present at all — `open`, `closed`, or unparseable — refuses a new proposal, at
both the preview and the application phase, with `transaction-outstanding`,
`journal-slot-occupied` or `journal-malformed`. Every progress update writes
with the exact content hash of the journal bytes just read. Discovery needs no
listing — the name is fixed, and `read-journal` addresses it with no
caller-supplied path.

**Retention is unconditional, because the journal holds the only copy of its
transaction's before-images.** This slice has no approved way to archive that
copy durably first, so it does not overwrite it at all: a second experiment on
the same owned run is refused, and another experiment uses a **fresh owned
run**. That is a real limitation of this slice, not a property of the design —
durable archival would need additional native command or path authority, which
is not approved and is not implemented.

A `closed` label is not proof of anything. Recovery re-proves a closed journal
against the records before reporting it complete, and no code path treats the
label as permission to overwrite.

**Bounds, checked before any note write.** Every note's bytes must be valid
UTF-8 that round-trips exactly through the string APIs the existing modules
expose; bytes that do not round-trip are refused (`non-roundtrip-bytes`) rather
than silently replaced with U+FFFD. Per note the limit is 256 KiB; the whole
serialized journal must be at most 2 MiB, well inside the helper's 4 MiB record
limit and its 16 MiB request limit. Both are computed and enforced **before the
first note write**, so an oversized transaction refuses with nothing mutated.

The journal must be readable after a restart, and the existing helper's
`read-records` returns only a **count** of evidence entries, not their contents.
See [§7](#7-process-ownership-and-locking) for the added command pair this
requires.

### Application

Files are applied one at a time, in `applyOrder`:

1. `put-note` with `EXPECT` set to the exact base content hash (update) or
   `absent` (create). The precondition is asserted by the helper immediately
   before the rename, under the lock — never by the coordinator at an earlier
   read.
2. Read the file back **twice** through the helper; require byte-identical
   results whose SHA-256 equals `targetContentHash`.
3. Republish the journal with that fileId appended to `progress.applied`,
   using the exact hash of the journal bytes just read as the precondition.

Steps 1 and 3 are two separate writes, so an interruption between them is
expected and must be survivable: the file is at its target but the journal does
not say so. Recovery resolves that from disk — it sees the target hash, treats
the file as applied, and the disagreement with `progress.applied` is recorded,
not treated as an error.

Other files are already visible to anything reading the graph at this point.
That is stated, not hidden: a single record write is atomic for a reader of that
one directory; a batch is not.

**Path and parent-directory guards, enforced by the applier before step 1.**
Restricting path syntax is not enough: `put-note` accepts any `.md`/`.org` path
inside the graph directory and, through `note_parent(..., create = 1)`, creates
every missing intermediate directory. Syntax alone therefore cannot stop the
helper from creating a directory. The applier requires all of:

- exactly two path components, `pages/<name>.md` or `journals/<name>.md` — no
  nesting, no `.org` in this slice, no component named `.` or `..`, no
  backslash, no `//`, no leading `/`;
- the first component is not `logseq`;
- `<name>` contains no `/` and the exact UTF-8 bytes are preserved;
- **the parent directory is proven to already exist**, by requiring that the
  accepted sidecar names at least one file in that same parent and that this
  file reads back through the anchored, non-following helper walk. A successful
  `read-note` of `pages/<known>.md` proves `pages/` exists and is a directory
  the helper can open without following a symlink. If no accepted file lives in
  the target's parent, the proposal is refused `unproven-parent-directory`.

With that proof in hand, incoming application creates no directory. Without it,
nothing is written.

### Recovery authority: what earns the right to write

**A journal is not trusted because it exists, parses, or contains plausible
hashes.** Before recovery may write one byte, every one of the following must
hold, and any failure refuses with a typed code and mutates nothing:

1. `schema` is exactly `f28-incoming-journal/1`; the record parses as JSON; the
   key set is exact at every level; no unexpected key is ignored.
2. Serialized size is within bounds; `applyOrder` is complete, unique, in byte
   order, and exactly the key set of `approved.files`; every per-file record has
   the exact key set and well-formed 64-hex hashes; every `contentHex` decodes,
   is valid UTF-8, round-trips, and hashes to its stated hash.
3. `approvedHash` equals the recomputed hash of `approved`. A mismatch is
   `journal-approved-tampered`.
4. `approved.graphBinding` and `approved.profileBinding` equal the bindings the
   store reports **now** — run name, directory name, device and inode for both
   trees. A journal from another run, another graph directory, another profile,
   or a relocated copy is `journal-binding-mismatch`.
5. `approved.graphId` equals the accepted sidecar's `graphId`.
6. The records are either **provably at the bound target** or exactly at the
   base. "Provably at the target" is not a revision label: it requires no
   outstanding intent, no malformed record, `openGraph` returning `accepted`,
   and the sidecar's `acceptedTransactionId`, `acceptedSnapshotFingerprint`,
   sidecar bytes and device bytes all equalling what `approved.target` bound.
   Anything else refuses.
7. The plan is **recomputed** with `compareSnapshots` from the accepted sidecar
   and the journal's target state, and must reproduce `approved.planId` exactly.
   A journal naming a plan the modules do not reproduce is `journal-plan-mismatch`.
8. `approved.target` binds the exact intended transaction ID, projected snapshot
   fingerprint, sidecar bytes hash and device bytes hash — all derived **before
   the first write** from the projected post-application state, so they can be
   proven afterwards rather than discovered from whatever the store published.
   Before publishing, recovery re-derives them from the state it is about to
   commit and refuses `transaction-mismatch` with nothing written if they
   differ.

**These checks establish consistency, not authenticity.** Every value compared
here lives in the same profile tree the recovering process can write. An
attacker who can write arbitrary bytes into the owned profile directory can
produce a self-consistent journal, and nothing here detects that. The checks
defend against malformed, truncated, stale, superseded, unrelated and
accidentally-substituted records — not against a deliberate forger with write
access. No cryptographic authenticity is claimed and none is implemented.

### Whole-transaction recovery preflight

Recovery classifies **every** file in `applyOrder` before applying **any** of
them. It never walks the order applying as it goes.

| Disk hash for a file | Classification |
|---|---|
| == `targetContentHash` | `applied` |
| == `beforeImage.contentHash`, or absent when the before-image is absent | `pending` |
| anything else, including absent when a before-image was present | `third-state` |

- If **any** file classifies `third-state`, recovery stops **before any further
  note mutation** and returns `third-state`, naming every affected file. A file
  late in the apply order in a third state therefore prevents writes to files
  earlier in the order that were still pending. Nothing is rolled back, nothing
  is reapplied, every before-image and journal byte is retained.
- Otherwise recovery writes only the `pending` files, in `applyOrder`, and
  **rechecks each remaining destination immediately before its own write** by
  passing the exact expected content hash (or `absent`) as the helper's `EXPECT`
  precondition. A destination that changed between the preflight and its write
  refuses at the helper (`destination-precondition-failed`) rather than being
  overwritten.
- That recheck is still a recheck-then-rename, not an atomic compare-and-swap.
  A writer that does not honour the cooperative lock can change the destination
  between the helper's recheck and its `renameat`; the rename then overwrites
  that change and the post-rename verification confirms only that the staged
  bytes landed. The preflight narrows this window; it does not close it.

`progress.applied` is compared against the disk classification and any
disagreement is reported. A file the journal calls applied but disk calls
pending is the expected outcome of an interruption between a note write and its
progress update; it is resolved by disk, not by the journal.

### Resolving the record store, not stepping around it

Notes and records are two separate durable steps, so recovery must finish both.

- **An outstanding identity transaction is never ignored.** If exactly one is
  outstanding and it is `approved.target.transactionId`, recovery resolves it
  through the record store's own contract — `PI.recover` with that exact
  transaction — and requires `recovered`. Anything else (`refused`, an uncertain
  classification, a post-recovery refusal) returns `unresolved`, leaves the
  incoming journal **open**, and retains every record, intent, evidence file and
  before-image. An uncertain state is never converted into success.
- **An outstanding transaction that is not ours is refused**
  (`unrelated-outstanding-transaction`) and left exactly as it was. More than one
  outstanding transaction refuses as `multiple-outstanding-transactions`.
- **Files pending while the records have moved on** is not a roll-forward
  situation; it refuses for review.
- **Nothing closes without proof.** After the record step, recovery reopens and
  re-proves the full binding of item 6. Only then is the journal closed, and the
  closed journal names the real transaction ID — never `null`.
- **A `closed` journal is re-proved too.** If its records do not verify, recovery
  refuses `closed-journal-not-verified` and retains everything, instead of
  reporting a completed transaction.

Recovery is **roll-forward only**. There is no automatic rollback. The
before-images exist so that a restoration can be offered to the user later, as
its own design and its own approval — not so that recovery can silently revert a
file.

### Identity is derived from disk, and the complete intended state is revalidated

Before the records are published, the **whole** intended state is revalidated
from disk, not just the files in the transaction:

- every transaction file must still hold its approved target bytes, or the
  publication refuses `target-divergence`;
- every file *outside* the transaction must still hold its accepted bytes, or it
  refuses `unrelated-local-change` — an unrelated local edit is never silently
  adopted into the accepted metadata by being reread and stamped with the
  intended revision;
- the resulting state must fingerprint as `approved.target.snapshotFingerprint`,
  or it refuses `projection-mismatch`;
- the transaction, sidecar bytes and device bytes these inputs produce must
  equal what the approval bound, checked by re-deriving them **before**
  publishing, so a mismatch refuses with nothing written.

Only then is `updateIdentity` called, with the file list the recomputed plan
projects and the revisions that plan assigned. `snapshotFromDisk` re-reads every
note through the helper and `enrollIdentityMetadata` verifies the content
against that snapshot.

This narrows the window between validation and publication. It does **not**
close it: a writer that does not honour the cooperative lock can still change a
file between this revalidation and the store's own reads, and that race is
unchanged by these checks.

## 5. OG reconciliation and watcher-echo handling

### Recommended first slice: the app is closed during application

#### The gate is verified, not assumed

Before **every** application write and **every** recovery write, the coordinator
proves the exact owned app has exited:

1. Every PID in the retained owned process tree from this session's launch is
   dead (`process.kill(pid, 0)` throws for all of them).
2. No running process's `comm` equals the exact packaged executable's basename,
   read through `ps -axo pid=,comm=`. This is a process check on one exact
   recorded executable name — never a name pattern, never a shared-root listing.

If `ps` fails, returns nothing parseable, or the tree cannot be evaluated, the
state is **uncertain** and the write is refused (`app-state-uncertain`). An
uncertain gate is never treated as closed. The check is re-run immediately
before each write rather than once per run, so a stale "closed" flag from
earlier in the batch cannot authorize a later write.

**What this gate does not do.** It excludes one app: the owned experimental
build this harness started. It does not exclude Finder, iCloud or other cloud
agents, external editors, a second coordinator, or the same app launched again
by anyone at any moment — including immediately after the check passes and
before the write lands. The cooperative lock does not cover any of them and the
check-then-rename race is unaffected by whether OG happens to be running.

#### What the closed window buys

There is no watcher and no reconciliation inside the application window, because
there is no application running. OG picks the files up on its next open through
its ordinary load path. Verification is the restart verification the live
capture batch already runs: reopen, confirm the applied content renders exactly,
confirm identity is still `accepted` at the new `metadataRevision`, confirm the
note byte hashes are unchanged across the reopen.

This deliberately tests nothing about watcher echo. See
[the recommendation](#should-the-first-experiment-require-the-app-to-be-closed)
for what that costs.

### The app-running path, designed now, not run now

When a later approved experiment applies while OG runs, the existing bridge
rules govern and no new suppression is introduced:

- Register one incoming cause per file with `register-incoming-cause!` **before**
  the write. It already refuses when `unfinished-local-write?` holds for that
  path, so an incoming write cannot race a pending local save or rename.
- After the file's read-back verifies, invoke the existing
  `watcher-handler/reconcile-from-disk!` boundary exactly once, with
  `from-disk? true`.
- The cause stays in flight across that asynchronous call, so duplicate
  observations share the in-flight work instead of starting a second call. Only
  successful settlement **followed by** successful transaction-bound progress
  storage lets a later identical event be classified as an echo. Either
  rejection leaves retryable evidence.
- **A real edit is never suppressed.** A watcher notification whose bytes,
  presence or path differ from the outstanding cause is a genuine local or
  external observation and enters capture or review even while that cause is
  outstanding. Zero matches and multiple matches both stay ordinary. Echoes are
  matched on complete state — graph, presence pair, exact paths, exact content
  hash — never on path alone and never on elapsed time. OG's existing
  three-second hosted-sync path suppression is not reused and is not a
  completion or identity protocol.
- Cause state is reconstructed from the durable journal after a restart, so a
  crash cannot turn every later event into an ignored echo.
- Global-directory watcher events are reported against OG's `local` placeholder
  repo before a graph is bound. They are unbound and must never be attributed to
  the graph identity.

This is not an exactly-once guarantee. A failure between an idempotent callback
and its progress record may repeat the callback; that is accepted and recorded,
not claimed away.

## 6. Sidecar/device-record acceptance ordering and restart

The record ordering is unchanged from the persistent identity design: intent
first, then (graph-first) sidecar and device record, then a separately-failing
clear. Cross-directory atomicity does not exist between the two anchored roots
and is not claimed.

The full durable order for one incoming application is four separately-failing
steps:

```
0  journal + before-images                    profile tree
1  per-file note writes, per-file markers     graph tree
2  updateIdentity: intent -> sidecar -> device -> clear   both trees
3  journal closed                             profile tree
```

Restart classification:

| Observed | Continuation |
|---|---|
| journal present, no file applied | resume step 1 only if every precondition still holds; otherwise refuse and retain |
| journal present, some applied | per-file three-state rule of §4; if all applied, go to step 2 |
| all applied, no intent | run `updateIdentity` for the exact transaction; identical inputs recompute the identical transaction ID, so this is a continuation, not a second write |
| an intent is outstanding | `recover()` owns it; its existing table (`prepared` / `graph-applied` / `device-applied` / `applied` / `mismatch`) applies unchanged |
| records accepted, journal not closed | verify and close; never reapply |

The interaction that matters most: a crash between step 1 and step 2 leaves the
graph with new note bytes and the sidecar at the old `metadataRevision` — the
disk-ahead state `openGraph` refuses as `snapshot-mismatch`. **The journal is
what distinguishes "incoming application in progress" from "an uncaptured local
edit."** Capture must consult the journal before treating those bytes as a local
edit, or an incoming change would be recaptured as if the user had typed it.

Where the failed step is the second record of an update (the device step under
graph-first ordering), the sidecar already names the target, so the store
refuses an identical re-issue with `stale-metadata-revision` and recovery of the
outstanding transaction is the only continuation. That path was exercised live in
the capture batch and is reused here unchanged.

Bindings are revalidated on every open: run, directory, device and inode for both
the graph and the profile. A moved or copied run refuses rather than silently
rebinding, and a copied graph still requires the explicit
`same-lineage-new-replica` / `new-graph-lineage` choice. Incoming application
never makes that choice.

## 7. Process ownership and locking

**The application gains nothing.** The packaged experimental build stays exactly
the observation-only runtime of the identity-capture stage: no persistence port,
no synchronization port, no sidecar write, no helper execution, no new
privileged IPC, no process-launch exception, no renderer filesystem access
beyond OG's own. The in-app process-launch refusal stays on. In the app-closed
slice the application source and binary are unchanged from commit
`e62dbbdadd157b368e3a8c03a3fa78437a079c4c`'s build.

**The writer.** In the incoming path the only writer of note files is the
anchored helper, invoked by an external operator-started Node coordinator outside
the app. In the local path OG remains the only writer of notes. In the
recommended slice the two never overlap, because the operator quits the app
first — an operating condition, not an enforced exclusion.

**Locking, exactly.** One cooperative lock at `<profileDir>/LOCK`, opened
`O_NOFOLLOW`, required to be an ordinary file, taken `LOCK_EX|LOCK_NB` for every
mutating command and `LOCK_SH` for reads, held for one command. It serializes
**participating helper invocations only.** OG, Finder, iCloud and other cloud
agents, and external editors do not honour it. End-to-end serialization of two
concurrent coordinator processes has never been tested and is not claimed. One
coordinator per owned run is a cooperative claim recorded in the journal
(proposalId, pid, start time) plus the operator procedure — not an OS guarantee.

**The check-then-rename race remains**, as stated in §2. So does the limit on
directory re-verification: the retained-parent-handle plus entry re-open check
detects, at the moment of the check, the graph or profile entry renamed away or
replaced by a different directory or a symlink. It does not cover ancestors above
those entries — the owned run or either root — and a relocation after the check
passes unnoticed, because the check and the use of its result are separate
operations. It is not an OS sandbox.

**No enumeration, ever.** Every path is an exact recorded owned path taken from
the run's own evidence. Retention is confirmed by a directory-existence check on
each exact recorded owned run directory; process state by a check on the exact
packaged executable name. Neither shared root is listed, with or without a
filter. This is the prevention rule from the recorded cleanup violation and it
binds this experiment.

### The two source changes this needs

1. **`putNote`'s hardcoded `expect: 'any'`** (`src/persistent-identity.js`) is a
   fixture-grade write and must not be reachable from the incoming path. It is
   split in two: `putNoteFixture`, which keeps `expect: 'any'` and is called only
   by explicitly identified fixture and test-seed callers, and
   `putNoteExpecting(context, path, bytes, expect)`, which **requires** an
   `expect` of `absent` or a 64-hex content hash and throws on anything else —
   there is no default and `any` is rejected outright. The incoming applier uses
   only `putNoteExpecting`, and a test asserts that `'any'` is refused there.
2. **A journal command pair in the anchored helper.** `read-records` returns only
   a count of evidence entries, so today the journal cannot be read back after a
   restart. The addition is exactly two commands, `write-journal` and
   `read-journal`, over **one compile-time constant name**,
   `incoming-journal.json`, directly inside the already-anchored owned profile
   directory. Neither command accepts a path, a name, a component or any other
   caller-selected location: the name is a `#define` in the helper and the
   caller cannot express a different one. Both go through the existing
   `publish_entry` / `read_entry` code, the existing cooperative lock
   (`write-journal` exclusive, `read-journal` shared), the existing anchoring
   walk and the existing entry re-verification. `write-journal` requires an
   `EXPECT` precondition exactly as every other record write does.
   **No new root, no new reachable location, no relaxed guard.**

   There is deliberately **no** `clear-journal` command, and no journal is ever
   replaced either. A finished journal is marked `closed` and retained forever;
   a second proposal on the same owned run is refused rather than allowed to
   overwrite it. Nothing in this code deletes or replaces a journal, which
   matches the approved "retained without cleanup" policy and keeps the command
   surface at two.

   The fixed name is also what makes [§4](#4-per-file-application-retained-before-images-interrupted-recovery)'s
   discovery rule work: a resumed coordinator reads one exact path and needs no
   directory listing, and a fresh proposal cannot start while that slot holds a
   journal of any kind.

   Two alternatives, both rejected and recorded: putting the journal in the graph
   tree under `logseq/.og-sync/` would put device-local operational state into
   the portable record; putting it outside both anchored roots would make the one
   record a restart must trust weaker than the records it coordinates.

## 8. Focused acceptance tests

Isolation first, headless, against the real helper and real modules with no
application involved — the pattern
`f28-identity-capture/checks/isolation-check.js` established.

| # | Check | Required outcome |
|---|---|---|
| 1 | Exact accepted base | plan phase succeeds |
| 2 | Wrong `base.metadataRevision`, wrong `base.snapshotFingerprint`, wrong `graphId` (three cases) | `unknown-base`; nothing written in any tree |
| 3 | Proposal carrying a plan `compareSnapshots` does not reproduce | `plan-mismatch`; nothing written |
| 4 | Apply without `--approve` | refused before any mutation |
| 5 | Apply with a stale `previewFingerprint` | `preview-stale`; nothing written |
| 6 | A note changed through the helper between plan and apply | `local-ahead-of-accepted`; note bytes, records and journal all unchanged |
| 7 | Destination bytes changed after preview, so the helper's `EXPECT` fires | `destination-precondition-failed`; the file on disk is preserved exactly |
| 8 | Two-file proposal, injected failure after the first file | file 1 at target, file 2 at base, journal shows exactly that, records still at the old `metadataRevision`, `openGraph` refuses `snapshot-mismatch` |
| 9 | Recovery of #8 | applies only the remaining file, then `updateIdentity` accepts once; exactly one new revision |
| 10 | After #8, the unapplied file is edited to a third value | `third-state`; nothing applied, nothing rolled back, before-images and journal retained |
| 11 | Injected `after-stage` failure at the device step, graph-first | `recovery-required`/`outstanding-intent`; note bytes unchanged; identical re-issue refused `stale-metadata-revision`; recovery classifies `graph-applied` and completes |
| 12 | Re-running the identical approved proposal after success | refused (the base no longer matches); no second revision |
| 13 | Korean target paths, create and update | exact UTF-8 bytes preserved; NFC/NFD and case-fold collision refused; nothing normalized or merged |
| 14 | Target path under `logseq/`, and a target path requiring a new directory | both refused by the applier before any helper call |
| 15 | Before-image fidelity | for a file still `pending`, the retained before-image hash equals its bytes on disk. **After a third-state edit the file deliberately differs from its retained before-image** — that is the third state — so the assertion there is that the before-image is still the *original* pre-application bytes, unmodified by the later edit, and that recovery reports `third-state` rather than restoring it |
| 16 | Sidecar portability after an incoming acceptance | `assertPortable` passes; `originReplicaId` appears nowhere in the sidecar |
| 17 | `hashGraphNotes` after acceptance | equals the projection; `extra` reported separately, never folded in |
| 18 | Pending-local-write gate | a proposal touching a path with a pending local cause is refused `unfinished-local-write` |
| 19 | Malformed journal: not JSON, wrong schema, missing key, extra key, bad hex, non-64-hex hash | each refused with its typed code; `mutated: false`; no note write |
| 20 | Tampered journal: a byte changed inside `approved` | `journal-approved-tampered` |
| 21 | Substituted journal: valid journal from a different owned run | `journal-binding-mismatch` on run name, directory, device or inode |
| 22 | Wrong `graphId`; wrong `transactionId`; wrong `previewFingerprint` | `journal-graph-mismatch`, `journal-transaction-mismatch`, `journal-preview-mismatch` |
| 23 | Stale journal whose base no longer matches the accepted records | `journal-base-mismatch`, except the records-advanced case of §4 item 6 |
| 24 | `applyOrder` incomplete, reordered, duplicated, or naming an unknown fileId | refused; no note write |
| 25 | Journal whose plan `compareSnapshots` does not reproduce | `journal-plan-mismatch` |
| 26 | Note bytes that are not valid UTF-8 or do not round-trip | `non-roundtrip-bytes`; refused before any write |
| 27 | Oversized: one note over 256 KiB, and a journal over 2 MiB | refused before the first note write; `mutated: false` |
| 28 | An `open` journal present, then an unrelated new proposal is submitted | refused `transaction-outstanding`; the new proposal never reaches a note write; the existing journal is unchanged |
| 28a | A `closed` journal present, then a second proposal | refused `journal-slot-occupied` at BOTH preview and application; the retained journal is byte-identical afterwards; the second proposal's file is untouched |
| 28b | An unparseable journal present, then a second proposal | refused `journal-malformed`; the bytes are retained exactly |
| 29 | Three-file proposal where the **last** file is in a third state | recovery refuses `third-state` before writing the earlier still-pending file; **zero** further note writes; every before-image retained |
| 30 | Interruption after a note write but before its progress update | recovery reads the target hash from disk, classifies `applied`, reports the disagreement with `progress.applied`, and does not rewrite the file |
| 31 | Interruption after records accepted but before the journal closes | recovery accepts the advanced base, performs no note write, no second `updateIdentity`, and closes the journal |
| 32 | Target whose parent directory is not proven by an accepted file | `unproven-parent-directory`; the helper is never invoked for that write, so no directory is created |
| 33 | Symlink at the destination note path | the helper preserves it and refuses (`destination entry is not a regular file`); the link is intact afterwards |
| 34 | Path shapes: nested, `.org`, `logseq/` prefix, `..`, backslash, `//`, absolute | each refused by the applier before any helper call |
| 35 | `putNoteExpecting` called with `'any'` or with no precondition | throws; incoming code cannot reach `EXPECT any` |

Live batch, one host, one fresh synthetic graph, app closed during application:

| # | Check | Required outcome |
|---|---|---|
| 19 | Enroll a fresh synthetic graph through OG as in the previous stage | accepted; note bytes unchanged by enrollment |
| 20 | Construct replica B in the coordinator: one English update, one Korean create; write the proposal to a local file in the owned profile run | no network, no second graph directory |
| 21 | Plan phase with the app running, observer healthy | preview produced; whole-graph note hash unchanged; nothing written to the graph |
| 22 | Attempt apply while the app is still running | refused `app-running` before any mutation; note bytes unchanged |
| 23 | Clean quit | no pending local cause at quit; no owned process remains |
| 24 | Apply with explicit approval | both files written and read back twice; `updateIdentity` accepted; whole-graph note hash equals the projection |
| 25 | Reopen | both files render with exactly the applied bytes; identity `accepted` at the new `metadataRevision`; byte hashes unchanged across the reopen |
| 26 | Final verification | only exact recorded owned paths and the exact executable name are checked; neither shared root is listed |

Every test asserts the mixed intermediate state explicitly rather than
describing the batch as atomic.

## Recommended first implementation slice

1. Change `putNote` to require an explicit precondition; keep the existing
   fixture caller working by passing `'any'` at its call site.
2. Add `write-journal` / `read-journal` to the anchored helper (approval item),
   or take the single-file fallback if that approval is withheld.
3. Add `src/incoming-application.js`: proposal validation, plan recomputation,
   the §2 checks, preview emission, per-file application, and recovery
   classification. No new lock, no new root, no new engine.
4. Add `f28-sync-prototype/tests/incoming-application.test.js` covering checks
   1–18 against the real helper in fresh owned children of one fresh run.
5. Add `f28-incoming/checks/isolation-check.js` and
   `f28-incoming/checks/run-incoming-application.js` in the coordinator pattern.
6. Run the live batch (checks 19–26) only after every item in the approval list
   below is decided.

Scope of the first slice: **create and update only.** Incoming rename and delete
are deferred, because the anchored helper has no note rename or delete command
and adding one is a separate native surface and a separate approval.

## Should the first experiment require the app to be closed?

**Yes — the first experiment should require the test app to be closed during
incoming-file application.**

**The benefit** is that it removes OG's watcher and OG's own writer from the
application window entirely. The only writer in that window is the anchored
helper, so the per-file preconditioned apply, the journal, the partial-apply
state and the recovery classification can be observed deterministically and
attributed unambiguously. It also means the application binary needs **no
change at all** — the observation-only build stays exactly as it was, the bridge
stays default-off, and no new authority is added to the app to run this
experiment. Reconciliation is tested in its simplest honest form: close, apply,
reopen, and confirm OG reads exactly the bytes that were written.

**The limitation** is that it tests nothing about the harder half of the
problem. The live watcher path, `reconcile-from-disk!`, echo classification, and
mixed visibility while OG is running are all untested by this slice, and §5's
app-running design stays a design. It also does not test the pending-local-save
gate against a real pending OG write, only against a synthetic one. And "the app
is closed" is an operator condition, not an exclusion mechanism: the user,
Finder, an external editor or a cloud agent can still write to the graph during
that window, the cooperative lock does not cover them, and the check-then-rename
race is unaffected by whether OG happens to be running.

So this slice buys a clean, attributable first result on the parts that must be
right first — base matching, conflict refusal, per-file recovery and record
ordering — and defers the watcher-coexistence problem to an experiment that has
to be designed and approved on its own terms.

## Decisions requiring user approval — all approved 2026-09-15

Recorded as asked and answered. Every item below was approved for this slice
only; none of them generalizes to personal data, a second host, or daily use.

1. **May the coordinator write note bytes into the enrolled test graph at all?**
   Every prior stage kept OG as the sole note writer. Incoming application ends
   that. **Approved**, for fresh synthetic data on Intel only.
2. **App closed during application as a hard gate for the first slice?**
   Recommended yes, for the reasons above.
3. **Adding `write-journal` / `read-journal` to the anchored helper** — two
   commands, one fixed name, inside the already-anchored profile directory, no
   new root and no relaxed guard. Declining means the single-file fallback,
   which tests less.
4. **Scope limited to create and update**, with incoming rename and delete
   deferred to a separate approval along with the native commands they need.
5. **Before-images containing note bytes stored in the profile tree**, bounded
   by the helper's 4 MiB record limit, retained indefinitely until a separately
   approved cleanup policy exists.
6. **Roll-forward-only recovery with no automatic rollback.** Before-images are
   evidence for a user-initiated restoration that is its own later design.
7. **No rebasing of a proposal whose base does not match.** Recommended: refuse
   and require recomputation, in this slice and until there is a reviewed design
   for the alternative.
8. **Reuse of the same two anchored roots** with one fresh owned run under each,
   no new root and no widened containment.

Enabling the OG bridge, any app-running application, any real transport, any
personal-data enrollment and any daily use remain separate approvals that this
document does not request.


## Supervisor review corrections (2026-09-16)

Three findings from the supervisor's review of the first implementation. Each
was reproduced against the real modules and the real anchored helper before it
was changed, and each now has focused regressions. What was actually verified,
and what remains unverified, is recorded in RESULTS.md.

### 1. Recovery could close an unresolved record-store transaction

`recoverIncoming` treated `sidecar.metadataRevision === approved.target.metadataRevision`
as acceptance. Because `openGraph` returns no sidecar when an intent is
outstanding, the code fell back to the raw parsed record, ignored the
`recovery-required` result, skipped record recovery entirely, and closed the
journal reporting `recovered` with `transactionId: null` — while the store still
held an outstanding intent and a device record at base.

Corrected as described in "Recovery authority" and "Resolving the record store":
the target binding is now an exact transaction, snapshot and record-bytes pair
computed before the first write; an outstanding transaction is resolved through
`PI.recover` or refused; and nothing closes without reopening and proving both
records.

### 2. Approval did not bind the revision that would be stored

`acceptedRevision` travelled from the proposal into the stored metadata, and
`proposalId` was never recomputed. Two proposals differing only in that field
produced the **same** approval fingerprint, and the caller's arbitrary string was
stored as the accepted revision.

Corrected as described in §1: proposals cannot express a revision at all,
revisions come from the executed plan, proposal identity is recomputed over the
whole canonical body, and the permissive `planId` check — which could never throw
for any string — is replaced by an exact shape.

### 3. Previous journal retention was optional and not durable

A second proposal overwrote a `closed` journal, destroying the only retained copy
of the first transaction's before-images. Retention depended on an optional
`supersededSink` callback whose only verified effect was appending to an
in-memory array.

Corrected by refusing journal-slot reuse outright, at both the preview and the
application phase, for open, closed and unparseable journals alike. The callback
is removed. **The limitation this leaves is explicit: one incoming transaction
per owned run.** A second experiment uses a fresh owned run. Durable archival
would need additional native command or path authority; that is not approved, not
requested here, and not implemented.
