# Applying an incoming change while the isolated OG test app is running

Status: **option A implemented and run; findings partially accepted**,
2026-09-16. This status line supersedes the "proposal only / nothing
implemented, approved or run" wording this document carried while it was a
proposal; that wording was correct when written and is no longer true.

The supervisor accepted the graph-binding correction and the **limited**
observation findings, and independently ran the memory-only probe checks
(15/15). The focused live result (14/14) remains coder-reported evidence. The
**complete live observation matrix is NOT accepted as finished**, and
**concurrent-edit safety is unverified and unclaimed**. The historical test
reports in `RESULTS.md` are preserved as written and are not re-labelled as
newly verified evidence.

Option **B** — the real editing/save barrier this document deferred — was
designed in [EDITING_PAUSE_DESIGN.md](./EDITING_PAUSE_DESIGN.md) and is now
**closed as deferred**, with six unresolved findings recorded in its §0.2.

It designs the next experiment after the **accepted** app-closed slice
([INCOMING_CHANGE_DESIGN.md](./INCOMING_CHANGE_DESIGN.md), results in
[RESULTS.md](./RESULTS.md)). That milestone stands within its documented limits
and nothing here weakens it.

## Retractions from the first draft of this design

The first draft (`769338420`) made four claims that source does not support.
They are withdrawn here and replaced by what the code actually does.

| Withdrawn claim | What source shows |
|---|---|
| "two independent preconditions make lost updates reliably detectable and refused" | Both preconditions are check-then-write with a gap. They can both pass against the same old state. See §2. |
| "cannot be applied or indexed twice"; "one database revision" | `handle-changed!` compares trimmed strings and `reconcile-from-disk!` awaits a backup before touching the database, so overlapping events can both pass the same stale comparison. See §3. |
| "the only filesystem event the incoming write produces is the one our own write produced" | `set-missing-block-ids!` can transact `id::` properties into **other** pages, which OG then saves as real file writes. See §3. |
| "the first slice needs no application change at all" / "reuse `incoming-application.js` unchanged" | The application is unchanged, but the **applier** is not: `applyIncoming` is wholly synchronous and has no awaited per-file reconciliation hook. See §4 and §7. |

---

## 1. Not overwriting an unsaved buffer, queued save, pending rename or failed save

**The bridge's pending-cause view is not sufficient.** `unfinished-local-write?`
(`og_sync_bridge.cljs:348`) only knows causes registered by `save-pending!`,
which runs inside `write-file-impl!` (`fs/node.cljs:22`) — after the editor, the
database, the outliner queue and the rate limiter. An edit can exist in at least
four earlier states with no cause at all:

| State | Where it lives | Source |
|---|---|---|
| Keystrokes in the editing block | `:editor/content` and the DOM input value | `state.cljs:930`; `editor.cljs:1322` reads `(gobj/get elem "value")` |
| Mid-IME composition (Korean) | `save-current-block!` **returns without saving** | `editor.cljs:1322` guard on `state/editor-in-composition?` (`state.cljs:1710`) |
| Committed, queued | `state/get-file-write-chan`, flushed on a 1000 ms rate limit | `outliner/file.cljs:17`, `:103` |
| Flushed, dispatched, still writing | between `write-files!` and the IPC call | `outliner/file.cljs:73`; `node.cljs:22` |

A **failed** save closes its cause as `:failed`, not `:pending`, so a naive
pending check passes while the file on disk is whatever the failure left.

### The signals, and exactly what each one does not prove

- **`state/get-edit-input-id` nil** — no block is in edit mode *now*. It says
  nothing about the next keystroke.
- **`state/editor-in-composition?` false** — no IME composition *now*.
- **`state/input-idle?`** (`state.cljs:1745`) — **not a quiet-period proof.** It
  returns true if the elapsed time since the last input exceeds `:diff`
  **or** simply `(not (get-edit-input-id))`. With no block in edit mode it
  returns true regardless of how recently anything happened.
- **`outliner-file/*writes-finished?`** (`outliner/file.cljs:99`) — **dispatch,
  not completion.** The flush function calls `write-files!` and then marks
  `{:value true}`, but `write-files!` → `do-write-file!` → `save-tree!` →
  `alter-files-handler!` (`modules/file/core.cljs:164`, `handler/file.cljs:203`)
  returns a promise that nobody awaits. So `true` means "the batch was
  dispatched", while the IPC writes may still be in flight. Its absence for a
  repo is `nil`, not `true`.

Together these are **evidence of an idle app, not proof that no save is in
flight**. The design must not claim otherwise. The only statement about bytes is
the accepted slice's stable two-read disk check against the accepted sidecar.

### Settling an edit changes the base

If an unsaved edit is settled first, that commit flows to disk and **changes the
accepted base**. An incoming proposal computed against the previous base is then
stale by construction. The correct sequence is therefore:

1. settle the edit and let it reach disk;
2. **capture** it through the existing capture path so the records advance;
3. **recompute the proposal and the preview against the new accepted base**;
4. obtain a fresh approval.

Applying a previously approved proposal after settling an edit is forbidden, and
the accepted slice already enforces it: the base no longer matches and
`planIncoming` refuses `unknown-base`.

## 2. Ordering and the window — what is *not* guaranteed

**Withdrawn:** the claim that the two preconditions reliably detect a lost
update. Both are check-then-write:

- OG's save path reads the file **asynchronously**
  (`p/let [disk-content (ipc/ipc "readFile" ...)]`) and only later calls
  `ipc/ipc "writeFile"` (`fs/node.cljs:22`). The compare and the write are
  separated by at least one IPC round trip.
- The helper rechecks `EXPECT` immediately before `renameat`, under its
  cooperative lock, but recheck and rename are still two operations.

So both checks can pass against the same old state before either write lands,
and the later write wins silently. What is true is narrower:

- a sequence where one write *completes* before the other's check still refuses;
- OG's `contents-matched?` branch, when it does fire, publishes
  `[:file/not-matched-from-disk ...]` and does not write
  (`handler/events.cljs:374` clears editing and opens a diff modal);
- once reconciliation has run, OG's `old-content` is the new content, disk
  matches, and OG saves normally.

**The honest statement is: interleaving is neither prevented nor reliably
detected.** The cooperative lock serializes participating helper invocations
only. Nothing serializes OG against the helper. This is the central reason the
recommendation below avoids concurrent editing entirely.

## 3. How OG notices the change — and why it is not exactly-once

The path is OG's ordinary external-change path:

```
helper write → chokidar "change" (awaitWriteFinish, fs_watcher.cljs:88)
  → publish-file-event!* reads content AT EVENT TIME (fs_watcher.cljs:~60)
    → handle-changed! (watcher_handler.cljs:59)
      → trimmed content ≠ trimmed db-content ?
        → reconcile-from-disk! (watcher_handler.cljs:45)
```

Four source facts that the first draft got wrong or omitted:

1. **The guard is a trimmed-string comparison**, not a byte comparison:
   `(not= (string/trim content) (string/trim db-content))`. A change that is
   **whitespace-only at the edges** — a trailing newline added or removed — is
   therefore **invisible to OG**. It is written to disk, but never reconciled and
   never indexed. This is a supported incoming change that OG will silently not
   show.
2. **Reconciliation is not serialized.** `reconcile-from-disk!` awaits
   `backup-file!` before calling `alter-file`. Two watcher events arriving close
   together both read the same `db-content` in `handle-changed!`, both pass the
   guard, and both proceed — producing two backups and two `alter-file` calls.
   There is no lock, no queue and no dedupe key.
3. **A delayed event carries the content read at its own event time**, which may
   be older than what is now on disk. If that older payload differs from
   `db-content` after trimming, it reconciles the database **backwards** to the
   older content.
4. **Reconciliation is not free of graph writes.** Besides the backup,
   `reconcile-from-disk!` calls `set-missing-block-ids!`
   (`watcher_handler.cljs:29`). For every `((uuid))` block reference in the
   incoming content whose target block exists but lacks a matching `id::`
   property, it calls `editor-property/batch-set-block-property!`
   (`handler/editor/property.cljs:76`), which runs `outliner-tx/transact!` with
   `:outliner-op :save-block`. That reaches `updated-page-hook`
   (`outliner/pipeline.cljs:12`) → `sync-to-file` → the write queue → real file
   writes **to other pages**, each with its own bridge save cause and its own
   watcher event.

### Classified side effects of reconciling one incoming file

| Effect | When | Where |
|---|---|---|
| Database update and re-render | content differs after trimming | in memory |
| Backup file | **only when the diff contains a deletion** (`string-some-deleted?`, `electron/handler.cljs:89`), so an append-only change writes none | `logseq/bak/<page>/<ISO>.Desktop.md` — a `.md` the helper's `hash_tree` counts |
| Backup pruning | more than six versions | deletes inside `logseq/bak` (`backup_file.cljs:27`) |
| **`id::` property writes to other pages** | incoming content contains block refs to blocks lacking `id::` | ordinary note files anywhere in the graph |
| Nothing at all | whitespace-only edge change | — |

The first draft's "backup exception" is **not** broadened to cover the `id::`
writes. They are a separate, larger effect: they mutate note files that are not
part of the transaction, under the accepted sidecar, and would make those files
diverge from their accepted content hashes. The first experiment must therefore
**use content with no block references**, and must assert that no file outside
the transaction changed — an assertion that would fail, correctly, if block refs
were present.

## 4. Telling our own change from a genuine new edit

Evidence is exact — graph, path, content hash, and the approved transaction —
never elapsed time:

- **Graph:** the repo `handle-changed!` resolved. Global-directory events bind to
  OG's `local` placeholder and are **unbound**; never attribute them to the graph.
- **Path and content:** exact UTF-8 path; `sha256(content)` compared with the
  `targetContentHash` the approval bound in the retained journal.
- **Transaction:** that hash comes from `approved.files`, already bound to the
  approved proposal and preview by the accepted slice.

A real edit on top of applied content produces a different hash at the same path,
so it is never mistaken for ours. But two limits must be stated:

- **Duplicates are not suppressed by us and not prevented by OG.** Our
  classification can mark a second identical observation as a duplicate *of our
  cause*; it cannot stop OG from reconciling twice (§3.2). "Exactly once" is not
  claimed.
- **Reconciliation-induced writes to other pages** (§3.4) appear as genuine local
  save causes on files we did not target. They are real OG edits, not echoes, and
  must be reported as such.

## 5. When each stage is finished — disk success is not visible-app success

| Stage | Done when | Evidence |
|---|---|---|
| Note write | staged write, `EXPECT` recheck, rename landed; file reads back twice identically with the approved hash | helper only |
| UI reconciliation | OG's database holds the new bytes for that path **and** the page renders them | `db/get-file repo path`; rendered text; `set-file-last-modified-at!` advanced |
| Identity publication | the accepted binding proven: no outstanding intent, `openGraph` accepted, transaction, snapshot and both record byte hashes equal the approval | unchanged |
| Transaction complete | all three, then the journal closes | unchanged |

Reconciliation is asynchronous, so it must be **polled with a bounded timeout**.
A timeout is `reconciliation-timeout`: the journal stays open, identity is not
published, and it is reported as a real state — not rounded up. For a
whitespace-only change (§3.1) reconciliation will **never** arrive; that input is
excluded from the first experiment rather than being allowed to time out
misleadingly.

## 6. Failure midway

Every accepted protection is preserved unchanged: pre-write authority validation
before any note mutation, retained before-images, the whole-transaction
preflight, roll-forward-only recovery, the bound transaction/snapshot/record
proof, and "a missing record is never success."

New states this slice introduces:

- **Written, not reconciled.** Disk ahead of the database. OG re-reads at the
  next graph load. The journal stays open until the records are proven.
- **Reconciled, identity not published.** The accepted "disk ahead of the
  sidecar" state; `openGraph` refuses `snapshot-mismatch`.
- **Reconciled twice.** Two backups, possibly two database revisions. Detected by
  counting reconciliations and backups, reported, not prevented.
- **Reconciled backwards by a delayed payload.** The database holds older content
  than disk. Detected by comparing the database against the approved target
  after the poll window; reported as `reconciliation-regressed`, never as success.
- **Other pages written by `set-missing-block-ids!`.** Files outside the
  transaction diverge from their accepted hashes. The accepted applier already
  refuses this at publication as `unrelated-local-change` — correctly — so the
  transaction cannot complete. Excluded by construction in the first experiment.
- **App dies mid-reconciliation.** Reconciliation is database-only; the next load
  re-derives from the file.

## 7. What must change — application versus applier

**The application package needs no change** for the recommended step: the
accepted observation-only `Logseq OG F28 IdentityCapture` build is reused
byte-identically, and the watcher path is OG's ordinary behaviour, present in
every build. No new IPC, no process-launch exception, no network permission; the
guards in `f28-origin/NETWORK_CONTROL.md` are untouched.

**The applier does need a small, explicit change.** `applyIncoming` is wholly
synchronous — it contains no `await`, no `async` and no promise — and it writes
notes, publishes identity and closes the journal in one pass. It has no place to
wait for a real reconciliation. The **smallest** orchestration change is:

1. Make `applyIncoming` `async`, and add one optional injected port
   `reconcile!(fileId, approvedFile)` returning a promise. When absent, behaviour
   is exactly today's (this preserves the accepted app-closed path unchanged).
2. After each file's read-back verifies and its progress entry is written, if the
   port is present, `await` it. A rejection or timeout throws
   `reconciliation-timeout`, which lands in the existing `interrupted` path: the
   journal stays open, identity is **not** published, before-images are retained.
3. Publish identity only after every file's reconciliation resolved.
4. On restart, `recoverIncoming` treats a file as `applied` from disk exactly as
   today, and — because reconciliation leaves no durable marker we control — it
   **re-runs the reconciliation wait** for every file before publication rather
   than assuming an earlier run reconciled. No new journal field is trusted for
   this.

**The gate must not be faked.** `assertAppClosed` (`incoming-application.js:191`)
requires `verdict.closed === true` and is the accepted contract. A quiescence
check must **not** return `closed: true` to slip past it. Instead the gate
becomes mode-aware with two explicit modes, and the applier passes its mode:

- `mode: 'app-closed'` — today's contract, unchanged, still the only mode the
  accepted results describe;
- `mode: 'app-idle'` — the new, weaker mode; the verdict carries
  `{ mode: 'app-idle', idle: true }` and never `closed: true`.

Results, evidence and documentation must name the mode, so no app-idle run can
ever be read as an app-closed result.

**Option "real editing barrier" would need more.** To hold OG still rather than
observe that it is still, there is no existing switch: `state/clear-edit!` and
`escape-editing` end the current edit but prevent nothing, and the outliner queue
has no pause. It would need new application hooks — a guarded "suspend writes"
flag consulted by `<ratelimit-file-writes!` and by the editor's save path — plus
a way for the coordinator to set it, which the observation-only package
deliberately has no channel for. That is new in-app authority and is not
requested here.

---

## The two options, named accurately

### A. Idle-app external-change observation experiment

The app is **open and idle**. The harness does not type; it *asserts* the idle
signals of §1 and accepts that they are evidence, not proof. One incoming file is
written and OG's ordinary external-change path is observed end to end.

This proves: OG indexes an externally applied change while running, how many
reconciliations and backups result, and whether the database converges on the
approved target. It explicitly proves **nothing about concurrent-edit safety**.

### B. Real temporary editing/save barrier

Actually suspend editing and the write queue for the window. Requires the new
in-app hooks and the channel to set them described in §7 — new application
authority, in the package whose whole value so far has been that it has none.

## Recommendation

**Do A, and call it what it is: an observation experiment, not an integration.**

It is the smallest step that produces evidence, it reuses the accepted package
byte-identically, and its only code change is the one injected `reconcile!` port
and the mode-aware gate. Crucially, the questions §2 and §3 raise — interleaving
is not reliably detectable, reconciliation is not exactly-once, reconciliation
writes to other pages — are exactly the questions A is designed to *measure*
rather than assume away.

**In everyday language:** we leave the app open but do not touch it. We write one
file from outside, then watch carefully: does the app notice, how many times does
it react, does it make backup copies, does it end up showing exactly what we
wrote? We learn how the app really behaves. We are **not** yet claiming it is
safe to do this while you are typing — that is a separate, larger question, and
this experiment is what would tell us whether it is worth asking.

**Separating the two claims, plainly:**

- *We can observe normal OG behaviour* — A delivers this.
- *We can safely integrate incoming writes with active editing* — A does **not**
  deliver this, and nothing in this document claims it. B, or something like it,
  would be required, and its cost is new in-app authority.

## Test plan — one Intel machine, synthetic, no transport

**Layout constraint, corrected.** The accepted slice permits **one incoming
transaction per owned run**, and a retained journal refuses a second proposal.
So each scenario that mutates or fails gets its **own fresh owned run** — a fresh
graph directory and profile directory under the existing approved roots — not one
shared graph. Read-only refusal cases that never write may share a run, and are
marked so.

| # | Case | Own run? | Required outcome |
|---|---|---|---|
| 1 | Idle app, one English update, no block refs | yes | written; reconciled; database and rendered page match; identity accepted at the bound transaction |
| 2 | Idle app, one Korean create, Korean path | yes | as above, exact UTF-8 preserved |
| 3 | Unsaved edit present in any block | shared (no write) | gate refuses `app-not-idle`; **nothing written**; the buffer survives |
| 4 | Mid-IME Korean composition | shared (no write) | refuses while `editor-in-composition?`; nothing written |
| 5 | Queued save inside the 1000 ms batch | shared (no write) | refuses; nothing written |
| 6 | Pending local rename touching either path | shared (no write) | refuses `unfinished-local-write` |
| 7 | Settle an unsaved edit, then apply | yes | the edit is captured, records advance, the old proposal refuses `unknown-base`, a **recomputed** proposal and fresh approval succeed |
| 8 | Duplicate / delayed watcher events | yes | **count** reconciliations and backups; assert the database converges on the approved target; no exactly-once claim |
| 9 | Delayed older payload | yes | if the database regresses, report `reconciliation-regressed`; never publish identity |
| 10 | Whitespace-only edge change | yes | OG does **not** reconcile; the experiment reports `not-reconcilable-by-og` rather than timing out silently; identity not published |
| 11 | A real local edit on top of applied content | yes | classified as a genuine observation, never an echo; the transaction does not claim it |
| 12 | Reconciliation timeout | yes | `reconciliation-timeout`; identity not published; journal open; app-closed recovery then completes it |
| 13 | Coordinator killed after the note write | yes | restart re-runs the reconciliation wait; no double write; no success reported |
| 14 | Incoming content **containing** a block ref | yes | `set-missing-block-ids!` writes other pages; publication refuses `unrelated-local-change`; the divergence is reported, not absorbed |
| 15 | Feature off | shared | with no coordinator running, editing, saving, renaming and reopening behave exactly as before |

Case 14 exists to *demonstrate* the §3.4 effect rather than hide it, and is why
cases 1 and 2 use content with no block references.

Whole-graph note hash cannot be asserted unchanged in any case that reconciles an
update: backups are `.md` and are counted. The assertion is per-file exact hashes
for every accepted file, plus an explicit inventory of every extra `.md`, each of
which must be under `logseq/bak/`.

### Recovery branches: critical here versus deferred

**Critical — must be covered before this slice can be accepted:** reconciliation
timeout (12); coordinator death before reconciliation (13); a local save tripping
`EXPECT` with the file preserved; OG's `:file/not-matched-from-disk` path being
reached and reported; and the two non-exactly-once behaviours (8, 9).

**Explicitly deferred, unchanged:** the record store's uncertain-clear branch;
`profile-first` ordering; an injected failure at the intent step; a failure
during recovery's own roll-forward write; a store `recover` returning
`post-recovery-refusal`; power-loss durability; cross-process serialization;
second-host behaviour.

## Bounded acceptance criteria

1. Cases 1–15 pass, each mutating case on its own fresh owned run.
2. No note is written while the idle gate is unsatisfied.
3. Identity is published only after reconciliation is confirmed against OG's
   database; timeout, regression and non-reconcilable inputs all block it.
4. Reconciliation and backup **counts** are recorded. No exactly-once claim is
   made anywhere in the results.
5. A genuine local edit is never classified as an echo.
6. The application package is byte-identical to the accepted one and its manifest
   still asserts observation-only with persistence and synchronization ports
   absent.
7. Every result names its gate mode, and no `app-idle` run is described in
   app-closed terms.
8. Results state plainly that concurrent-edit safety was not tested.

## Decisions requiring user approval

1. **Run an incoming application while the owned test app is open and idle**,
   understanding that idleness is asserted from signals that are evidence, not
   proof, and that interleaving is neither prevented nor reliably detected.
2. **Add the one injected `reconcile!` port and make `applyIncoming` async**, with
   the app-closed path unchanged when the port is absent.
3. **Make the gate mode-aware** with an explicit `app-idle` mode that never
   returns `closed: true`, so the accepted app-closed contract is preserved and
   distinguishable.
4. **Accept that reconciliation is not exactly-once**, and that the experiment
   measures and reports reconciliation and backup counts instead of guaranteeing
   one.
5. **Accept the graph-write side effects**: `logseq/bak/**.md` from backups, and
   — demonstrated deliberately in case 14 — `id::` property writes to other pages
   via `set-missing-block-ids!`.
6. **Allow the harness to read app state and settle edits through the existing
   automation channel**, adding no application permission, while noting this is a
   test affordance a real user's app does not have.
7. **Defer option B** (a real editing/save barrier) and the new in-app hooks it
   requires to a separate, later request.

Incoming rename and delete, real transport, a second device, personal-data
enrollment and daily use remain out of scope and unrequested.
