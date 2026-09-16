# Applying an incoming change while the isolated OG test app is running

Status: **proposal only**, 2026-09-16. Nothing here is implemented, approved or
run. Written from documentation and source review; no graph, profile or helper
was touched in producing it.

It designs the smallest useful next experiment after the accepted app-closed
slice ([INCOMING_CHANGE_DESIGN.md](./INCOMING_CHANGE_DESIGN.md), results in
[RESULTS.md](./RESULTS.md)). It reuses the existing modules and adds no second
synchronization engine.

## The decisive source finding

**OG already reconciles an externally changed file, and already refuses to do it
twice.** `handle-changed!` (`src/main/frontend/fs/watcher_handler.cljs:59`) only
reconciles when the bytes on disk differ from what the database holds:

```clojure
(and (= "change" type) (= dir repo-dir)
     (not= (string/trim content) (string/trim db-content))
     ...)
```

and `reconcile-from-disk!` (`watcher_handler.cljs:45`) calls
`file-handler/alter-file` with `:from-disk? true`. In `alter-file`
(`src/main/frontend/handler/file.cljs:144`) the file write is guarded by
`(when-not from-disk? (write-file-aux! ...))`, so reconciliation updates the
database and re-renders but **writes no file**.

Three consequences shape this whole design:

1. There is no echo *write*. The only filesystem event the incoming write
   produces is the one our own write produced.
2. A duplicate or delayed watcher event for the same bytes finds
   `content = db-content` and reconciles nothing. Double-indexing is prevented
   by content comparison, not by a timer.
3. **The first slice needs no application change at all.** The accepted
   observation-only package already reaches this path, because it is OG's
   ordinary "someone edited the file outside the app" behaviour.

That last point is what makes a bounded first experiment possible inside current
authority.

---

## 1. Not overwriting an unsaved buffer, queued save, pending rename or failed save

**The bridge is not sufficient, and must not be treated as sufficient.**
`unfinished-local-write?` (`og_sync_bridge.cljs:348`) only knows about causes
registered by `save-pending!`, which is called inside `write-file-impl!`
(`src/main/frontend/fs/node.cljs:22`) — that is, *after* the edit has already
travelled through the editor, the database, the outliner queue and the
rate limiter. An edit can exist in at least four earlier states with **no bridge
cause at all**:

| State | Where it lives | Source |
|---|---|---|
| Keystrokes in the editing block | `:editor/content` + the DOM input value | `state.cljs:930` `get-edit-input-id`, `editor.cljs:1322` reads `(gobj/get elem "value")` |
| Mid-IME composition (Korean) | composition in progress; `save-current-block!` **returns without saving** | `editor.cljs:1322` guard on `state/editor-in-composition?` (`state.cljs:1710`) |
| Committed to the database, queued | `state/get-file-write-chan`, flushed on a 1000 ms rate limit | `outliner/file.cljs:17` `batch-write-interval`, `:103` `<ratelimit-file-writes!` |
| Flushed, writing, not yet at the IPC call | between `write-files!` and `save-pending!` | `outliner/file.cljs:73`, `node.cljs:22` |

A **failed** local save closes its cause with `:failed` (`og_sync_bridge.cljs`
`save-failed!`), which is not "pending" — so a failed save would pass a naive
pending check while the file on disk is whatever the failure left. Disk state,
not cause state, must decide.

**Quiescence proof for the experiment** — all of these, re-checked immediately
before the write, and any failure refuses:

1. `state/get-edit-input-id` is `nil` (no block is in edit mode).
2. `state/editor-in-composition?` is false.
3. `state/input-idle?` for the repo with an explicit `:diff` at least
   `batch-write-interval` (1000 ms), so the rate limiter cannot still be holding
   a batch.
4. `outliner-file/*writes-finished?` for the repo is `{:value true}`.
5. No bridge cause for that graph is `:pending` for either `:save` or `:rename`
   (`unfinished-local-write?` semantics, but as one signal among several).
6. The stable two-read disk check of the accepted slice still matches the
   accepted sidecar (`INCOMING_CHANGE_DESIGN.md` §2b), which is the only check
   that speaks about the bytes rather than about intentions.

(1)–(5) are read through the harness's existing automation channel, the same
channel the accepted coordinator already uses for `create_page`, `insert_block`
and `flushPageThroughOg`. It adds no application permission, and it is a
**test-harness affordance, not a product mechanism** — a real user's app exposes
none of this.

**A pending rename** is the one case the design does not attempt: incoming
rename and delete are out of scope, and an outstanding *local* rename cause for
either the source or destination path refuses the whole proposal, exactly as
`unfinished-local-write?` already specifies.

## 2. Ordering, the window, and what the mechanism actually controls

Ordering for one file: **settle → prove quiescent → write through the anchored
helper with an exact precondition → observe OG reconcile → verify → publish
records**.

The window between checking local state and writing is real and is not closed:

- The quiescence proof of §1 **observes**; it controls nothing. OG can begin a
  save in the instant after it passes.
- The helper's cooperative lock serializes **participating helper invocations
  only**. OG, Finder, iCloud and external editors do not honour it.
- The helper's `EXPECT` recheck happens immediately before `renameat`, under
  that lock, but recheck and rename are two operations.

What actually protects each direction is a precondition, and there is one for
each:

- **Us overwriting OG:** if OG wrote in the window, the destination content hash
  no longer equals `EXPECT`, and the helper refuses
  (`destination-precondition-failed`). Detection, not exclusion.
- **OG overwriting us:** OG's own save path reads the file back and compares it
  with `(or old-content (db/get-file repo rpath) "")` before writing. On a
  mismatch it publishes `[:file/not-matched-from-disk ...]` and **does not
  write** (`node.cljs:22`, the `contents-matched?` branch). The event handler
  (`src/main/frontend/handler/events.cljs:374`) clears editing and opens a diff
  modal. So an un-reconciled incoming change makes OG stop and ask, rather than
  clobber; once reconciliation has run, `old-content` is the new content, disk
  matches, and OG saves normally. Note `skip-compare? true` bypasses the compare
  entirely, but the note-saving path does not use it: `save-tree!` reaches
  `alter-files-handler!` (`handler/file.cljs:203`), which passes only
  `{:old-content ...}`. Only the global-config, plugin-config and persist-var
  writers pass `skip-compare?`.

Neither is a lock, and the experiment must claim neither. The honest statement
is: two independent preconditions make a lost update *detectable and refused*,
in a window nothing serializes.

## 3. How OG notices and indexes the change, once

The chosen path is the **existing** one, unmodified:

```
helper write → chokidar "change" (awaitWriteFinish, fs_watcher.cljs:88)
  → publish-file-event! → handle-changed! (watcher_handler.cljs:59)
    → content ≠ db-content ?  → reconcile-from-disk! (watcher_handler.cljs:45)
        → alter-file :from-disk? true  → DB + re-render, NO file write
```

It cannot be applied or indexed twice because:

- the content guard in `handle-changed!` makes a repeat event with identical
  bytes a no-op;
- `:from-disk? true` suppresses the write-back in `alter-file`, so no second
  filesystem event is generated;
- no competing path is enabled. The bridge's own incoming machinery
  (`register-incoming-cause!`, `og_sync_bridge.cljs:360`, and
  `reconcile-incoming!`) is **not** used in this slice; in the accepted package
  its ports are absent, so `observe-watcher!` (`:633`) resolves
  `complete-state!` to `nil`, matches nothing and returns `{:status :ordinary}`.
  It records; it does not act.

**Two OG-side side effects the experiment must expect rather than flag as
tampering:**

- For an **update**, `reconcile-from-disk!` passes `backup? true`, so OG writes
  `logseq/bak/<page>/<ISO timestamp>.Desktop.md`
  (`src/electron/electron/backup_file.cljs:7`, `:36`). That file ends in `.md`,
  and `hash_tree` in the anchored helper counts every `.md`/`.org` outside
  `logseq/.og-sync`, so **the whole-graph note hash and note count will change**.
  Per-file assertions stay exact; the whole-graph hash must be asserted
  differently (see the test plan).
- For a **create**, `db-content` is blank, so `backup?` is false and no bak file
  is written.
- `truncate-old-versioned-files!` keeps only the newest six backups, so OG also
  deletes inside the graph over repeated runs.

## 4. Telling our own change from a genuine new edit

Not by time. The evidence is exact and already available:

- **Graph:** the observation event carries the repo the watcher event resolved
  to (`handle-changed!` passes it to `observe-watcher!`). Global-directory
  events are bound to OG's `local` placeholder and are **unbound** — they must
  never be attributed to the graph.
- **Path:** the exact UTF-8 relative path, compared byte-for-byte.
- **Content:** the watcher event's `content` hashed and compared with the exact
  `targetContentHash` the approval bound.
- **Transaction:** that target hash comes from `approved.target`/`approved.files`
  in the retained journal, which the accepted slice already binds to the
  approved proposal and preview.

Classification for one observation:
`graph matches AND path matches AND sha256(content) == the approved target hash
for that path AND that file's journal entry is not yet marked reconciled`
⇒ **our change**. Anything else — a different hash at the same path, a path not
in `approved.applyOrder`, an unbound global event — is a **genuine observation**
and must be recorded as such, never suppressed. A second observation with our
exact target hash after reconciliation is a duplicate and is idempotent by §3.

The asymmetry that matters: a real user edit *on top of* our applied content
produces a different hash at the same path, so it is never mistaken for an echo.

## 5. When each stage is finished — disk success is not visible-app success

Four distinct completions, asserted separately and never conflated:

| Stage | Done when | Evidence |
|---|---|---|
| Note write | the helper's staged write, precondition recheck and rename landed and the file reads back twice identically with the approved hash | anchored helper only; no app involvement |
| UI reconciliation | OG's database holds the new bytes for that path **and** the page renders them | `db/get-file repo path` equals the content; the rendered text contains it; `db/set-file-last-modified-at!` advanced |
| Identity publication | the accepted slice's binding is proven: no outstanding intent, `openGraph` accepted, transaction, snapshot and both record byte hashes equal the approval | unchanged from the accepted slice |
| Transaction complete | all three above, then the journal closes | unchanged |

`reconcile-from-disk!` is asynchronous (`p/let`, with `re-render-root?`), so
reconciliation must be **polled with a bounded timeout**. A timeout is not
success: it is `reconciliation-timeout`, the journal stays open, and identity is
not published. Disk success with no reconciliation is a real and reportable
state — it is exactly what the app-closed slice produces on purpose — and the
experiment must be able to say so rather than round it up.

## 6. Failure midway

Every protection from the accepted slice is preserved unchanged: pre-write
authority validation before any note mutation, retained before-images, the
whole-transaction preflight, roll-forward-only recovery, the bound
transaction/snapshot/record-hash proof, and the rule that a missing record is
never success.

What is new is that OG may be partway through *indexing*:

- **Coordinator dies after the note write, before reconciliation.** Disk is
  ahead of the database. OG's next graph load re-reads files, and the content
  guard reconciles it then. Recovery classifies from disk exactly as today; the
  journal stays open until the records are proven.
- **Coordinator dies after reconciliation, before identity publication.** The
  accepted "disk ahead of the sidecar" state. `openGraph` refuses
  `snapshot-mismatch`; the journal distinguishes it from an uncaptured local
  edit. Unchanged.
- **The app dies mid-reconciliation.** Reconciliation is database-only and
  content-guarded, so the next load re-derives from the file. Nothing on disk is
  half-written by OG.
- **Reconciliation fails or never arrives.** `reconciliation-timeout`; nothing is
  reported complete; the journal, before-images and records are retained. The
  operator may quit the app and fall back to the accepted app-closed recovery,
  which is already verified.
- **The app writes during the window.** The helper's `EXPECT` refuses; or, if OG
  wrote after our rename, OG's own compare raises the diff modal and refuses.
  Both are recorded; neither is resolved automatically.

**A missing reconciliation record is never turned into success.** The one new
failure mode with no equivalent today is a reconciliation that *appears* to
succeed while the database disagrees, which is why §5 asserts the database
contents rather than the absence of an error.

## 7. Application hooks and permissions

**Option B as recommended below requires none.** The accepted
`Logseq OG F28 IdentityCapture` package is reused unmodified: observation-only
runtime, no persistence port, no synchronization port, no helper execution, no
new IPC, no process-launch exception, no network permission. The watcher path it
exercises is OG's ordinary behaviour, present in every build.

**Option A would require a real in-app incoming runtime**, and that is a large
authority change. `reconcile-incoming!` (`og_sync_bridge.cljs:491`) needs three
injected ports that the observation runtime does not have
(`make-observation-runtime`, `:190`): `:complete-state!` must read the
filesystem from the renderer, `:reconcile!` must call
`watcher-handler/reconcile-from-disk!`, and `:record-reconciliation-progress!`
must persist progress. Supplying them means enabling persistence and
synchronization ports inside the application — precisely what the current
package's manifest asserts are absent, and what every result so far has relied
on. It is not in scope here and is not requested.

Nothing in this design relaxes the network or process guards described in
`f28-origin/NETWORK_CONTROL.md`.

---

## The two options

### A. Apply while editing continues, with demonstrated coordination

Requires the in-app incoming runtime of §7, plus a real answer to §1's window
while the user is actively typing — including mid-IME composition, where OG
itself will not save. The coordination would have to be demonstrated, not
assumed, and the failure surface (partial reconciliation during an active edit,
a save racing an incoming write on the same block) is the hardest part of the
problem.

### B. A short explicit "apply pending changes" pause

Settle local edits, prove the app is quiescent, hold still, apply, reconcile,
verify, resume. No application change; uses OG's existing external-change path;
every new assertion is an observation of state OG already maintains.

## Recommendation: **B**, and B first

**In everyday language:** the app stays open the whole time. When an incoming
change is ready, the experiment first makes sure you are not in the middle of
typing — it finishes saving whatever is in the block you were editing, waits for
the app's one-second save batch to flush, and checks that nothing is still
queued. Then, in that quiet moment, it writes the file. The app notices the file
changed — the same way it would if you had edited the file in another editor —
and updates itself on screen. Then the experiment checks that what is on screen
and in the app's index really matches what was written, and only then records the
change as accepted.

**Why B and not A:** B needs no new application authority at all, which means the
first app-running result can be obtained on the *already-accepted* package with
no new trust placed in the app. It also isolates one question — "does OG index an
externally applied change correctly and exactly once, while running?" — from the
much harder question of concurrent editing. A remains possible later; B is the
evidence A would need anyway.

**What B does not do:** it does not prevent anyone from typing. "Temporarily
prevents new edits" is, in this synthetic experiment, the harness simply not
typing and then *asserting* that no input arrived (the editor's last-input time
and the write-queue state are unchanged across the window). There is no OG
read-only mode being engaged, and a real user could type at any moment. The
window is short, and the preconditions of §2 are what make that safe to detect —
not safe to prevent.

## Smallest first slice

One host, Intel, one fresh owned synthetic graph, the accepted package reused
unmodified, app **running** throughout, creates and updates only, one incoming
transaction per owned run.

1. Reuse `incoming-application.js` unchanged for proposal, preview, approval,
   per-file application, journal and recovery.
2. Replace the app-closed gate with a **quiescence gate** implementing §1, and
   keep the gate's existing contract: re-evaluated before every write, an
   unreadable state is uncertain and refuses, and it is never cached.
3. Add a **reconciliation observer** in the coordinator: after each file's
   read-back verifies, poll OG's database for that path until it matches or a
   bounded timeout expires, using the automation channel.
4. Publish identity only after every file's reconciliation is confirmed.
5. Record the observation stream for the whole window as evidence.

No new native command, no new root, no new IPC, no new permission.

## Test plan — one Intel machine, synthetic, no transport

| # | Case | Required outcome |
|---|---|---|
| 1 | Idle app, one update + one Korean create | both files written; OG reconciles both; database and rendered page show the new bytes; identity accepted at the bound transaction |
| 2 | Unsaved edit in the target block | the gate refuses `app-not-quiescent`; **no note written**; the buffer is still in the editor; the edit is not lost |
| 3 | Unsaved edit settled first, then apply | `save-current-block!` commits, the batch flushes, `*writes-finished?` turns true, the gate passes, application proceeds |
| 4 | Queued save (edit committed, within the 1 s batch) | the gate refuses until the queue flushes; nothing written meanwhile |
| 5 | Korean mid-IME composition | the gate refuses while `editor-in-composition?` is true; no write; no data loss |
| 6 | Pending local rename touching either path | refused `unfinished-local-write`; nothing written |
| 7 | Duplicate and delayed watcher events for our exact bytes | exactly one reconciliation; the repeats are no-ops by the content guard; one database revision |
| 8 | A real local edit on top of the applied content | classified as a genuine observation, never an echo; OG reconciles or refuses on its own terms; the incoming transaction does not claim it |
| 9 | Reconciliation never arrives (timeout) | `reconciliation-timeout`; identity **not** published; journal open; before-images retained; safe quit and app-closed recovery completes it |
| 10 | Coordinator killed after the note write, before reconciliation | on restart, recovery classifies from disk, does not double-write, and does not report success |
| 11 | Korean content and Korean paths throughout | exact UTF-8 bytes preserved; rendered text matches; NFC/NFD and case collisions still refused |
| 12 | Feature off | with the coordinator not running, normal OG editing, saving, renaming and reopening behave exactly as before; the observation runtime records but changes nothing |
| 13 | OG's own backup writes | after an update, `logseq/bak/**.md` exists and the whole-graph note **count and hash change**; this is expected, is attributed to OG, and per-file hashes remain exact |

Case 13 is the reason the whole-graph note hash cannot be asserted as unchanged
in this slice, as it was in the app-closed slice. The correct assertion is: every
file named by the accepted sidecar has its exact expected hash, and every extra
`.md` that appeared is under `logseq/bak/`.

### Untested recovery branches

**Critical for this slice — must be covered before it can be accepted:**

- reconciliation timeout with the journal left open (case 9);
- coordinator death between note write and reconciliation (case 10);
- a local save racing the write window and tripping `EXPECT`
  (`destination-precondition-failed`) with the file preserved;
- OG's `:file/not-matched-from-disk` path being reached, and the experiment
  reporting it rather than absorbing it.

**Explicitly deferred, unchanged from the accepted slice:**

- the uncertain-clear branch of the record store;
- `profile-first` publication ordering;
- an injected failure at the intent step;
- a failure during recovery's own roll-forward write;
- a store `recover` returning `post-recovery-refusal`;
- power-loss durability, cross-process serialization, second-host behaviour.

## Bounded acceptance criteria

The slice is acceptable if, and only if:

1. Cases 1–13 pass on one fresh owned synthetic graph, Intel, app running.
2. No note is written while the quiescence gate is unsatisfied, in any case.
3. Every reconciliation is confirmed against OG's database before identity is
   published, and a timeout blocks publication.
4. Exactly one database revision results from each applied file, across
   duplicate and delayed watcher events.
5. A genuine local edit is never classified as an echo.
6. The application package is byte-identical to the accepted one, and its
   manifest still asserts observation-only with persistence and synchronization
   ports absent.
7. Every claim distinguishes disk success from visible-app success.

## Decisions requiring user approval

1. **Run an incoming application while the owned test app is open.** Every
   accepted result so far required it closed. This is the substance of the
   request.
2. **The harness may drive OG's own editor and query its state through the
   existing automation channel** to settle edits and prove quiescence — the same
   channel already used for page creation and flushing, adding no application
   permission, but doing so in order to authorise a write rather than only to
   observe.
3. **Accept that the whole-graph note hash will change** because OG writes
   `logseq/bak/**.md` during reconciliation, and that per-file hashes plus a
   bak-scoped exception replace it as the assertion.
4. **Accept a short quiet window that is asserted, not enforced.** Nothing
   prevents typing; the experiment detects and refuses rather than excludes.
5. **Confirm Option B before Option A**, deferring the in-app incoming runtime —
   and with it any enabling of persistence or synchronization ports inside the
   application — to a separate, later request.

Incoming rename and delete, real transport, a second device, personal-data
enrollment and daily use remain out of scope and unrequested.
