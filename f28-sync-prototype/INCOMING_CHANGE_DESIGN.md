# Incoming change application design

Status: proposal, written before any implementation, filesystem work or test in
this stage. Nothing here is implemented or approved. It designs how a change
that did not originate from this device's OG can be applied to an enrolled test
graph **without silently overwriting a newer local edit**, reusing the existing
capture, comparison, identity-store and observation components. It introduces no
second sync engine.

Every prior stage kept OG as the sole writer of note files. This design ends
that, for one experiment, inside the existing anchored roots. That is the single
largest authority change proposed so far and it is listed first under
[Decisions requiring user approval](#decisions-requiring-user-approval).

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

**The proposal never names revisions on its own authority.** The applier
reconstructs the source snapshot from the accepted sidecar, reconstructs the
proposer's target state, and recomputes the plan with `compareSnapshots`. If the
recomputed plan is not byte-identical to `plan`, the proposal is refused
`plan-mismatch` and nothing is written. This is the `:revalidate-plan!`
discipline the end-to-end adapter already verifies; it is not weakened here.

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
last-writer-wins and no "newer timestamp wins". Every refusal changes nothing,
retains everything, and returns a typed code.

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

Before any note byte is written, the coordinator writes one device-local record
in the profile tree:

```
schema             "f28-incoming-application/1"
proposalId, planId, previewFingerprint
transactionId      the identity-store transaction this will become
base, target       as in the preview
applyOrder         fileIds in byte order
files[]            fileId, oldPath, newPath, precondition,
                   beforeImage { presence, contentHash, content | null },
                   targetContentHash, targetContent
```

`beforeImage.content` is the exact pre-application bytes. It lives only in the
profile tree — device-local, never in the sidecar, never portable — bounded by
the helper's 4 MiB record limit. The journal is also where `applied` markers go,
each written as a separate record so "applied" is never inferred from anything.

The journal must be readable after a restart, and the existing helper's
`read-records` returns only a **count** of evidence entries, not their contents.
See [§7](#7-process-ownership-and-locking) for the one added command pair this
requires, and the approval it needs.

### Application

Files are applied one at a time, in `applyOrder`:

1. `put-note` with `EXPECT` set to the exact base content hash (update) or
   `absent` (create). The precondition is asserted by the helper immediately
   before the rename, under the lock — never by the coordinator at an earlier
   read.
2. Read the file back **twice** through the helper; require byte-identical
   results whose SHA-256 equals `targetContentHash`.
3. Write that file's `applied` marker to the journal.

Other files are already visible to anything reading the graph at this point.
That is stated, not hidden: a single record write is atomic for a reader of that
one directory; a batch is not.

Path guards the applier enforces before step 1, because the helper does not:
`put-note` accepts any `.md`/`.org` path inside the graph directory and creates
missing intermediate directories. The applier therefore refuses any target path
whose first components are `logseq/` and restricts the first slice to
`pages/<name>.md` and `journals/<name>.md`, so incoming application creates no
directory at all.

### Interrupted recovery

Recovery classifies **from the bytes actually on disk**, never from a phase
field — the same rule the record store already follows.

| Disk hash for a file | Classification | Action |
|---|---|---|
| == `beforeImage.contentHash` (or absent when the before-image is absent) | not applied | may continue if its precondition still holds |
| == `targetContentHash` | applied | confirmed; never rewritten |
| any third value | third state | **stop** |

A third state stops recovery for the whole transaction. Nothing is rolled back
over what may be a user edit, nothing is reapplied, every before-image, marker
and staged byte is retained, and the outcome is `third-state` with a new
reviewed preview required before anything else happens.

Recovery is **roll-forward only**. There is no automatic rollback. The
before-images exist so that a restoration can be offered to the user later, as
its own design and its own approval — not so that recovery can silently revert a
file.

### Identity is derived from disk, not from the proposal

After every file verifies, the new records are produced by calling the existing
`updateIdentity` with the file list the recomputed plan projects.
`snapshotFromDisk` re-reads every note through the helper and
`enrollIdentityMetadata` verifies the supplied content against that snapshot, so
a file whose bytes do not match is refused at that point rather than recorded.
The proposal's bytes are the input to the write; the disk's bytes are the input
to the record.

## 5. OG reconciliation and watcher-echo handling

### Recommended first slice: the app is closed during application

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

1. **`putNote`'s hardcoded `expect: 'any'`** (`src/persistent-identity.js:242`)
   is a fixture-grade write and must not be used for incoming application. The
   incoming path requires an explicit precondition parameter — `absent` or an
   exact hash — with no `any` default. The helper already implements it; only
   the JS wrapper is changed, and the existing fixture caller keeps its current
   behaviour through an explicit argument.
2. **A journal command pair in the anchored helper.** `read-records` returns only
   a count of evidence entries, so today the journal cannot be read back after a
   restart. The proposal is exactly two commands, `write-journal` and
   `read-journal`, over one fixed name `incoming-<proposalId>.json` inside an
   `incoming/` subdirectory of the already-anchored owned profile directory,
   through the same `publish_entry` / `read_entry` path, the same lock, the same
   anchoring, the same `EXPECT` precondition and the same entry
   re-verification. The name is derived from a validated 64-hex proposal ID, so
   the command expresses no path at all. **No new root, no relaxed guard, no new
   reachable location** — but it is still an added native command surface inside
   the boundary, so it is an approval item, not a coder decision.

   Two alternatives, both rejected and recorded: putting the journal in the graph
   tree under `logseq/.og-sync/` would put device-local operational state into
   the portable record; putting it outside both anchored roots would make the one
   record a restart must trust weaker than the records it coordinates.

   If the user declines the helper change, the fallback is a **single-file**
   first proposal, where the existing intent's `base`/`target`/`staged` fields
   already cover the whole transaction and no journal is needed. That fallback
   does not produce a mixed intermediate state, so it tests less.

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
| 15 | Before-image fidelity after every refusal above | the retained before-image hash equals the file's bytes on disk for every unapplied file |
| 16 | Sidecar portability after an incoming acceptance | `assertPortable` passes; `originReplicaId` appears nowhere in the sidecar |
| 17 | `hashGraphNotes` after acceptance | equals the projection; `extra` reported separately, never folded in |
| 18 | Pending-local-write gate | a proposal touching a path with a pending local cause is refused `unfinished-local-write` |

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

## Decisions requiring user approval

1. **May the coordinator write note bytes into the enrolled test graph at all?**
   Every prior stage kept OG as the sole note writer. Incoming application ends
   that. Nothing below matters until this is decided.
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
