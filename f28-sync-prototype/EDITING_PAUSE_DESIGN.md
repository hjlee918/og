# A controlled editing/save pause for applying one incoming change

Status: **CLOSED AS DEFERRED**, 2026-09-16. Nothing here is implemented,
approved or run, and **nothing here is to be implemented**. Written from source
and documentation review; no graph, profile, helper or application was touched.

The supervisor accepted revision 2's recommendation to defer this design and
retain the accepted app-closed path. **Revision 2 is not safety-complete**, and
must not be labelled or cited as such: the review recorded six unresolved
findings, listed in §0.2, which invalidate specific mechanisms described below.
They are **recorded, not redesigned** — resolving them is out of scope for a
deferred proposal.

Revision history, preserved: revision 1 (`63e4625f5`) was reviewed and found to
leave its central guarantee unresolved; revision 2 (`1fed5b3ef`) replaced the
quiet-window drain with ownership tracking, refused application while any
unsaved buffer exists, split timeout and crash handling into two regimes,
corrected the protection claims, and reversed the recommendation. This revision
adds §0 only; §1–§9 are left as revision 2 wrote them, with a marker on each
section a finding invalidates.

## Revision 2: claims withdrawn from revision 1

| Withdrawn claim | What is actually true |
|---|---|
| The drain produces "the first genuine completion signal for saves in this project" | A stability window is a quiet timer, not a completion barrier. Revision 1 conceded work can exist before `save-pending!` and then called the result genuine anyway. Replaced by explicit ownership tracking (§2). |
| Live case 1: leave unsaved text in a buffer, apply, then let the buffer "save normally" | That buffer would save the **pre-application** content over the newly applied file. The case was unsafe as written. Replaced (§3, §8). |
| "Deferred pages are re-queued exactly once on resume" | Replaying a queue entry means replaying a **stale in-memory database** over applied content. The gate was also placed after `outliner-tx/transact!`, so the database was already mutated. Withdrawn; the first slice **prevents** the mutation instead (§3). |
| "Editing always resumes on restart" and "every blocked state self-releases" | A renderer timeout cannot prove that an external helper operation is not running. The journal blocks the coordinator, not OG's writer. Split into two regimes (§5). |
| §5.1: the editor buffer is preserved across failure and restart | A process kill destroys the DOM buffer. Revision 1 implied otherwise and case 10 asserted it. Withdrawn outright; no persistence mechanism is designed here (§5.4). |
| §1.3/§5.3: uncontrolled paths are "detected, not prevented" by `EXPECT` plus publication checks | `revalidateIntendedState` (`incoming-application.js:1066`) walks only an **enumerated** set of `approved.files` and `approved.unchanged`, and `checkNotePath` (`:119`) admits only direct-child `.md` under `pages/` and `journals/`. A file that was never in the accepted snapshot, and every non-note file, is not covered at all. Both checks are also check-then-write. Replaced by the three-bucket table (§6). |
| "Five application seams (H1–H5)" | The actual scope of a defensible pause is **twelve** seams, three of which sit in OG's universal save path (§7). |

Nothing below converts injected records, synthetic `CompositionEvent`s,
same-process `recoverIncoming` calls or simulated secondary writes into claims
about real integration.

## Accepted status, restated unchanged

The graph-binding correction and the **limited** idle-app observation findings
are accepted; the supervisor independently ran the memory-only probe checks
(15/15); the focused live result (14/14) remains coder-reported evidence; the
**complete live observation matrix is not accepted as finished**; and
**concurrent-edit safety remains unverified and unclaimed**, including after
this design, which is a proposal.

## 0. Supervisor disposition and unresolved findings

### 0.1 Disposition

The recommendation in §9 — defer the pause, retain the accepted app-closed path
for the next prototype — is **accepted**. This proposal is closed. The approval
items formerly listed at the end of this document are **withdrawn**; they are
retained below for the record and are not open decisions. Any future attempt at
an in-application barrier requires a new scope decision and would start from
§0.2, not from §1–§8.

### 0.2 Unresolved findings

Each finding is blocking. Each names the section it invalidates. **None is
resolved here**, and none may be read as a design.

#### F1 — Authorization expiry does not terminate an admitted helper operation

§5.2 step 2 offers "the authorization's own expiry has passed by more than the
allowed clock skew" as a way to establish writer termination. The helper
protocol has no such contract and cannot acquire one by being described.

Source: `f28-sync-prototype/native/identity_store_helper.c`. The request parser
(`parse`, `:~236`) accepts a fixed field set — `MAGIC`, `COMMAND`, `GRAPHROOTHEX`,
`EXPECT`, `DATAHEX`, `END` and the run/owner/target fields — and there is **no
expiry, deadline, lease or nonce field anywhere in it**. The command set is
exactly nine (`:221-223`): `init`, `put-note`, `read-note`, `hash-graph`,
`read-records`, `write-record`, `clear-intent`, `write-journal`, `read-journal`.
**There is no termination, revocation, abort or cancel command.** Each
invocation is a one-shot process that dispatches and returns (`return 0` per
command, `:784`, `:807`, `:827`, `:859`, `:887`, `:905`, `:912`, `:924`). The
only serialization is a cooperative `LOCK` in the owned profile (`acquire_lock`,
`:374-378`), which orders participating helper invocations and nothing else.

Consequence: once `put-note` has been started it runs to completion or the
process dies. An expiry the helper never reads cannot stop it, and the
coordinator holds no handle that revokes it. §5.2's step 2 second branch is
fiction as specified.

#### F2 — §5.4 contradicts §5.2, and "resume anyway" is a risk override

§5.2 requires **both** writer termination **and** per-path reconciliation before
affected writes resume. §5.4 says that once the recorded expiry has passed "the
block lapses to an advisory notice naming the files to verify" — which reopens
writes having established neither. The two cannot both hold.

Separately, §5.3's confirmed **"Resume editing these files anyway"** action is an
**unapproved risk override**, not evidence of safety. Revision 2 presented it as
the resolution of the lockout problem. It is a decision to proceed without the
guarantee, taken by a user who cannot observe the helper either. It is recorded
here as an open risk-acceptance question, not as a mechanism.

#### F3 — §3.1 and live case 5 are incompatible as specified

§3.1 requires, as a precondition for closing admission, that the ledger be empty
and that no bridge cause be `pending` — it refuses `local-work-pending` and
`unfinished-local-write` otherwise. Live case 5 (§8.4) requires "admission
closed with one write already dispatched" and asserts the drain waits for it.

Under §3.1 that state is refused before admission ever closes, so case 5 cannot
be constructed. Either the precondition admits some in-flight work, or the case
is unreachable. Revision 2 specified both and reconciled neither. Case 4 and
case 5 were both marked mandatory, so this is not a cosmetic conflict: the two
mandatory cases contradict each other.

#### F4 — A synchronous listener does not prove exact ledger ownership

§2.1's synchrony argument is correct as far as it goes — admission happens
before `transact!` returns — but §2.2 and §2.3 draw a stronger conclusion from
it than it supports. Three specific ways exact ownership fails:

1. **Deduped admissions.** `write-files!` iterates
   `(set (map #(take 3 %) pages))` (`outliner/file.cljs:76`), dropping the epoch,
   so admissions differing only in time collapse into **one** `do-write-file!`
   call. Which admissions that one call retires is undefined, and admissions
   arriving into the next batch must not be retired by it.
2. **No admission-to-bytes correspondence.** The tree is read once at dispatch
   (`do-write-file!`, `outliner/file.cljs:60-70`) and `save-tree-aux!`
   (`modules/file/core.cljs:146`) re-pulls the page (`:148`) before rendering it
   (`tree->file-content`, `:157`). The bytes written reflect the database **as of
   dispatch**, covering every mutation accumulated since — not any one admitted
   mutation.
3. **Terminal paths below `do-write-file!` that end before a cause exists.**
   §2.2 places retirement at `do-write-file!`'s three branches, but a dispatched
   write can still end without any cause opening: `save-tree-aux!` publishes a
   `:capture-error` and writes nothing for blank content
   (`modules/file/core.cljs:158-161`), and logs and writes nothing when the file
   path is invalid (`:165-166`). Such an entry never retires, so the drain cannot
   complete and refuses at `drain-timeout` — a false refusal, and evidence that
   the retirement set is incomplete.

**Withdrawn from this finding.** An earlier draft of F4 asserted a fourth item —
that dispatch creates a new admission re-entrantly, via `save-tree!`'s no-file
branch calling `transact-file-tx-if-not-exists!` (`modules/file/core.cljs:115`)
and its `db/transact!` (`:141`). **The cited chain does not establish it.**
`invoke-hooks` calls `updated-page-hook` only for entries in `:pages`
(`outliner/pipeline.cljs:109-111`), and `get-blocks-and-pages`
(`modules/datascript_report/core.cljs:24-52`) collects `:pages` only from a
changed entity's `:block/page` reference (`:33-35`) or from explicit
`:from-page`/`:target-page` in `tx-meta` (`:45-47`). That transaction changes a
file entity (`{:file/path …}`) and a page entity
(`{:block/name … :block/file …}`); neither carries `:block/page`, and it passes
no `tx-meta`. So `:pages` is empty, `updated-page-hook` is not called, and
`sync-to-file` does not run. Calling `d/transact!` alone does not imply an
admission. The claim is withdrawn rather than restated more weakly.

Consequence: the ledger as specified is not an exact ownership record. It may be
sound enough to **refuse** on, but §2.4's claim that the drain passes on
positive facts about tracked objects is not established.

#### F5 — G1/G2 do not cover all editor transactions

§1.1 places G2 at `save-current-block!` (`editor.cljs:1322`) and G1 at
`set-editing!` (`state.cljs:1921`), and §3.4 concludes that during the pause
"no editor-originated database mutation occurs at all". That conclusion does not
hold.

**Two concrete bypasses establish it.** `cycle-todos!` (`editor.cljs:745`) and
`delete-blocks!` (`editor.cljs:871`) each call `outliner-tx/transact!` directly,
and each operates on `get-selected-blocks` (`editor.cljs:732`), which reads
`state/get-selection-blocks` — **selected** blocks, not an editing block. They
therefore run with **no block in edit mode at all**, which is precisely the state
§3.1 requires before admission closes. G1 does not apply (nothing calls
`set-editing!`), G2 is not on the path (nothing calls `save-current-block!`), and
G3 sees the result only **after** the database has been mutated — reintroducing
the stale-in-memory-state problem revision 2 claimed to eliminate. Either example
alone refutes §3.4's invariant.

For context only, and **not as a coverage metric**: `outliner-tx/transact!`
appears at 23 direct call sites across five files — `handler/editor.cljs` (19),
`handler/editor/property.cljs:82`, `handler/block.cljs:78`,
`handler/dnd.cljs:43`, `util/page_property.cljs:86`. A raw call-site count does
not measure gate coverage: some of those sites are reached only through paths the
gates do cover, and others are not editor-initiated at all. The census indicates
where to look; the two bypasses above are the evidence.

Also unresolved: §4.3 refuses block-reference payloads so that
`set-missing-block-ids!` transacts nothing, but the design never states the
general rule that distinguishes a **prohibited local mutation** from a
**required reconciliation mutation** at G3. Both arrive at `sync-to-file`
identically. Without that rule G3 either deadlocks reconciliation or admits
local edits.

#### F6 — The durable marker has no approved schema, target or lifecycle

§5.4's per-path marker is described only by what it must achieve. Its schema,
its target, its publication/read/clearing lifecycle and its restart ordering are
undesigned, and revision 2 implied existing helper support was sufficient
without saying what that support would be.

**Correction to an earlier draft of this finding.** That draft claimed
`put-note` is the only graph-writing command and that `write-record` targets the
profile only, concluding that a new helper command is necessarily required.
**Both claims are wrong.** `write-record` with `target: sidecar`
(`identity_store_helper.c:865-872`) opens the **graph** anchor and publishes
through `open_sidecar_directory` (`:693-702`) into the graph-local
`logseq/.og-sync` directory, with the same staged-write, destination recheck,
rename publication and entry re-verification as every other record. `hash_tree`
already **excludes** `logseq/.og-sync` (`:548`, `:588`), so a file there is not
counted as a note. That draft also cited `valid_note_path` at `:~700`; it is at
`:172`.

So an anchored, owner-verified, graph-local write path **already exists**, and
whether a future design would extend an existing command, add a target, or add a
command is **open** — this document prescribes none of them.

What does not exist, and is what makes H11 undesigned:

- **No approved marker schema.** Nothing defines the bytes, their versioning, or
  how a torn or partial marker is distinguished from a valid one.
- **No dedicated target.** `request.target` is an enumerated set — `none`,
  `sidecar`, `device`, `intent`, `evidence` (`:229`) — and each is already bound
  to an identity or recovery record. `sidecar` holds `identity-v1.json`
  (`SIDECAR_NAME`, `:35`), so writing a marker through it would **overwrite the
  identity record**. Identity records must **not** be repurposed to carry a
  marker, and this document does not propose doing so.
- **No lifecycle contract.** Who clears the marker if recovery never runs is
  unanswered; note that there is deliberately no `clear-journal` command
  (`:895-898`), so "retained forever" is the existing house pattern and a marker
  would need its own answer.
- **No restart-ordering contract.** The marker's write is not ordered against the
  note write it is meant to protect, and nothing says what happens when the
  marker and the journal disagree.
- **No OG-side read contract.** How OG reads a graph-local marker before the
  graph is bound is not specified. (Reading an ordinary graph file needs no new
  permission; the ordering does need a contract.)

### 0.3 Sections these findings invalidate

| Finding | Sections not sound as specified |
|---|---|
| F1 | §5.2 step 2, §5.4 expiry row |
| F2 | §5.3, §5.4 |
| F3 | §3.1 precondition set, §8.4 cases 4 and 5 |
| F4 | §2.1 conclusion, §2.2, §2.3, §2.4 |
| F5 | §1.1 G1/G2, §3.4, §4.3 |
| F6 | §5.4 marker, §7 H11 |

**§6 is partly affected.** Its "Controlled" row attributes coverage to
"G1/G2/G3 + the ledger + causes" — the very mechanisms F4 and F5 show are not
established. **That row's coverage claim is unestablished** and must not be
cited as a guarantee. The "inert in the synthetic setup" row (which rests on
build and containment facts, asserted at run start) and the "outside the
guarantee" row (external writers, a second OG window, main-process and asset
writes) remain valid, as does §6's statement that the barrier excludes nothing.

§9 (recommendation) is unaffected.

## Non-goals

- Not continuous concurrent editing, not a synchronization service, not a
  transport, not a background loop.
- Not incoming rename or delete. Creates and updates only, as accepted.
- Not exclusion of Finder, cloud agents, external editors, a second Logseq
  window or a second instance (§6).
- Not exactly-once. Not whole-graph atomicity, power-loss durability or
  cross-process serialization.
- **Not unsaved-buffer persistence across a process kill** (§5.4).
- One host, synthetic data, no second device, no personal data.

---

## 1. Admission control

An overlay is not a write barrier, and — revision 1's error — neither is a gate
placed after the database transaction. By the time `sync-to-file` runs, the
mutation is already committed to the in-memory database and is already stale
relative to anything applied afterwards. Admission must close **before**
`outliner-tx/transact!`.

### 1.1 The layers, and where the gates go

> **Superseded — see §0.2 F5.** Selected-block operations — `cycle-todos!` and `delete-blocks!` — transact directly with no block in edit mode, bypassing both gates. Recorded, not redesigned; not to be implemented.

| # | Layer | Source | Gate |
|---|---|---|---|
| 0 | Entering edit mode | `state/set-editing!` `state.cljs:1921`, four call sites (`components/block.cljs:2303`, `:5629`; `handler/editor/property.cljs:72`; `extensions/code.cljs:459`) | **G1 — refuse entry** |
| 1 | Keystrokes: DOM textarea value and `:editor/content` | `state.cljs:128`, `:920`; the value read at save time is `(gobj/get elem "value")` `editor.cljs:1343` | never touched |
| 2 | Commit into the database | `save-current-block!` `editor.cljs:1322` | **G2 — refuse the commit** |
| 3 | Database → file queue | `updated-page-hook` `outliner/pipeline.cljs:12` → `sync-to-file` `outliner/file.cljs:86` → `async/put!` onto `:file/writes` (`state.cljs:34-39`) | **G3 — refuse, and register in the ledger (§2)** |
| 4 | Rate limiter | `<ratelimit-file-writes!` `outliner/file.cljs:101`, interval 1000 ms `:17`, installed at `handler.cljs:240` | flush-now only, never blocked |
| 5 | Write execution | `write-files!` `:73` → `do-write-file!` `:46` → `save-tree!` `modules/file/core.cljs:168` → `alter-files-handler!` `handler/file.cljs:203` → `write-plain-text-file!` `fs.cljs:93` → `write-file-impl!` `fs/node.cljs:22` → IPC | **never gated** — this is what drains |
| 6 | Cause registration | `save-pending!` `og_sync_bridge.cljs:269` | ownership, §2 |

G1 and G2 together mean that during the pause **no editor-originated database
mutation occurs at all**, so there is nothing stale to replay on resume. G3
remains as a backstop for non-editor transactions and as the ledger's
registration point; it is not the primary gate.

### 1.2 Uncontrolled paths

These write graph files without passing through the outliner queue. Each is a
real bypass. §6 classifies each as inert-by-setup or outside the guarantee.

**Renderer, through `fs/write-plain-text-file!` but bypassing layers 2–4**, most
with `{:skip-compare? true}`, which also skips the disk-compare precondition
(`fs/node.cljs:25-36` — no `readFile`, no `:file/not-matched-from-disk`):
plugin API (`logseq/api.cljs:176`, `:196`, `:328`; `logseq/sdk/git.cljs:28`;
`handler/plugin.cljs:563`; `handler/plugin_config.cljs:42`, `:49`); config
(`handler/global_config.cljs:76`; `handler/file.cljs:129`);
`util/persist_var.cljs:69`; PDF assets (`extensions/pdf/assets.cljs:70`,
`:119`); drawings (`handler/draw.cljs:32`); `handler/events.cljs:901`;
file-sync merges (`fs/sync.cljs:1598`, `:1648`, `:1675`).

**Renderer, bypassing `fs.cljs` entirely — no bridge cause exists at all:**
asset writes, `ipc/ipc "writeFile"` at `handler/editor.cljs:1451`.

**Main process:** `:backupDbFile` → `logseq/bak/**` (`electron/handler.cljs:94`,
`backup_file.cljs:7`, `:19`, pruning `:27`); `:addVersionFile` →
`logseq/version-files/local/**` (`electron/handler.cljs:118`); `unlink`,
`rename`, `copyFile` (`fs/node.cljs:105`, `:128`, `:131`) — rename has a cause
(`handler/page.cljs:221`), unlink and copy have none.

**A second OG window on the same graph.** `repo-listen-to-tx!`
(`db.cljs:127-141`) sends every transaction to other windows over the `dbsync`
IPC. A second window has its **own** write queue, its own rate limiter and its
own barrier state. This renderer's pause does not reach it.

**Outside the process:** Finder, iCloud/Dropbox agents, an external editor,
`git checkout`, a second instance.

---

## 2. Completion tracking

The review is correct: a stability window bounds waiting and proves nothing.
What follows is ownership tracking from admission to settlement. Every drain
condition below is a **positive fact about a tracked object**, never the absence
of recent activity.

### 2.1 Why a ledger at layer 3 is complete for outliner-originated writes

> **Superseded — see §0.2 F4.** Synchrony holds; the ownership conclusion drawn from it does not. Recorded, not redesigned; not to be implemented.

The database listener chain is **synchronous**:

```
d/transact!  (outliner/datascript.cljc:155)
  → d/listen! callback              db.cljs:127-141
    → @*db-listener                 db.cljs:140  (wired at handler.cljs:197)
      → after-transact-pipelines    outliner/datascript.cljc:30-33
        → invoke-hooks              outliner/pipeline.cljs:85
          → updated-page-hook       outliner/pipeline.cljs:111
            → sync-to-file          outliner/file.cljs:86
              → async/put!          outliner/file.cljs:97
```

Nothing in that chain awaits. **A committed database mutation cannot exist
without its queue admission having already happened**, before `transact!`
returns. So a ledger entry created at `sync-to-file` has no window against the
transaction that caused it. This is the fact that makes the ledger sound, and it
is the reason a ledger is worth building at all.

(`invoke-hooks` skips when `:from-disk?` is set, `pipeline.cljs:88`, which is
what reconciliation's `alter-file` passes — `watcher_handler.cljs:52`. So
reconciliation's own database write raises no admission. `set-missing-block-ids!`
does, because `batch-set-block-property!` transacts without that flag; see §4.4.)

### 2.2 The ledger: admission → retirement

> **Superseded — see §0.2 F4.** The retirement set is incomplete and dedupe leaves ownership undefined. Recorded, not redesigned; not to be implemented.

Entry key `[repo page-db-id]`, each entry carrying an admission id and a
re-queue count.

**Registered at** `sync-to-file` (`outliner/file.cljs:97`, before the put!) and
at the re-queue inside `do-write-file!` (`:59`).

`sync-to-file` has a second branch: while `:graph/importing` is set it calls
`write-files!` directly (`:95-96`), bypassing the queue and the rate limiter
entirely. The ledger must register that branch too, and the pause must refuse
`graph-importing` outright rather than drain against a moving import.

**Retired at `do-write-file!`, which has exactly three terminal branches:**

| Branch | Source | Retirement |
|---|---|---|
| no write at all — `blocks-count` zero and not a deletion; or the single blank block guard | `outliner/file.cljs:54`, `:64-66` | `no-op`, retired |
| re-queued — long page, or a busy whiteboard | `:55-59` | `requeued`, retired; a fresh entry is registered |
| dispatched — `save-tree!` called | `:60-70` | **ownership transfers to a cause** (§2.3) |

**The re-queue terminates, and this is checkable.** The long-page branch
requires `(not (state/input-idle? repo {:diff 3000}))`, and `input-idle?`
returns true whenever no block is in edit mode (`state.cljs:1745-1755`) — which
G1 and G2 guarantee during the pause. The whiteboard branch requires
`(not (whiteboard-idle? repo))`, which is purely 3000 ms since the last persist
(`state.cljs:1757-1763`). Both go true and stay true once admission is closed.
The ledger still caps re-queues and refuses `drain-requeue-limit` rather than
looping.

### 2.3 Ownership transfer, and the one gap that is closed by construction

> **Superseded — see §0.2 F4.** Ownership across the transfer is not established: deduped admissions leave retirement undefined, and a dispatched write can settle on a pre-cause terminal path without any cause opening, so the entry never retires. Recorded, not redesigned; not to be implemented.

After `save-tree!` the path is synchronous — `save-tree-aux!`
(`modules/file/core.cljs:145`), `db/pull`, `tree->file-content`,
`alter-files-handler!` (`handler/file.cljs:203`) — until `write-file-f`'s
`p/let`, which defers to a microtask before calling `write-plain-text-file!`.
So a cause **cannot** be opened before the first await.

That gap is closed by not trying to bridge it: **the ledger entry is retired
only when the cause opens.** A write sitting in the microtask gap has an
unretired ledger entry, so the drain waits. A renderer killed inside that gap
loses the write entirely — the database is ahead of the file, which is OG's
ordinary crash behaviour, repaired by re-reading at the next graph load.

**The cause must open before the first I/O.** Today
`write-plain-text-file!` opens one only under `observation-only?`
(`fs.cljs:99-101`). In a barrier build that branch must be taken under
`enabled?`, because `protocol/write-file!` (`fs/node.cljs:117-125`) performs an
IPC `stat` and an IPC `mkdir-recur!` **before** `write-file-impl!` opens its own
cause at `:26`/`:58`. Without the outer cause, two IPC round trips would be
covered by nothing.

An admission token links the two so the transfer is explicit rather than
inferred. It is carried by a dynamic binding established around `save-tree!` and
captured eagerly in `alter-files-handler!` before its `p/let`, then passed in the
options map — this avoids changing the `:file/writes` malli coercer
(`state.cljs:34-39`) and `write-files!`'s dedupe (`outliner/file.cljs:75`), both
of which a payload-threaded token would force.

### 2.4 The drain condition

> **Superseded — see §0.2 F4.** The drain does not pass on established positive facts. Recorded, not redesigned; not to be implemented.

Admission closed (G1, G2, G3) → flush-now → wait until **all three** hold:

1. the ledger has no unretired admission for the owned repo;
2. no bridge cause for the owned repo is `pending`;
3. no bridge cause for the owned repo is `failed`.

A quiet timer bounds the wait. **On expiry the drain refuses**
(`drain-incomplete`) and resumes editing. It never passes.

### 2.5 What this still does not cover, stated plainly

- Writes that never reach `fs.cljs`: the asset IPC (`handler/editor.cljs:1451`).
- Main-process writes: backups, version files, unlink, copy.
- A second OG window's queue (§1.2).
- **A completed cause does not prove a write happened.** The
  `:file/not-matched-from-disk` branch (`fs/node.cljs:55`) returns without
  writing while the outer `fs.cljs` cause still resolves as completed. Results
  must not read cause-completed as bytes-written.

---

## 3. Unsaved buffers and pending database changes

### 3.1 Policy: refuse, do not defer-and-replay

> **Superseded — see §0.2 F3.** This precondition set makes mandatory live case 5 unconstructible. Recorded, not redesigned; not to be implemented.

The pause may close admission only over a state with nothing unsaved and nothing
admitted. Preconditions, all of which must hold at the moment admission closes:

| Precondition | Signal | On failure |
|---|---|---|
| no block in edit mode | `state/get-edit-input-id` nil (`state.cljs:930`) | refuse `unsaved-buffer-present` |
| no IME composition | `state/editor-in-composition?` false (`state.cljs:1710`) | **defer**, §3.3 |
| no editor action open | `state/get-editor-action` nil (guarded at `editor.cljs:1331`) | refuse `editor-action-open` |
| ledger empty for the owned repo | §2.2 | refuse `local-work-pending` |
| no pending or failed cause | `og_sync_bridge.cljs:348`, `:305` | refuse `unfinished-local-write` / `failed-local-write` |

A refusal writes nothing, blocks nothing and resumes immediately.

**There is no "deferred mutation" state in this slice.** Because G1 and G2 close
before `outliner-tx/transact!`, the database is not mutated during the pause, so
there is nothing to reconcile and nothing to replay. That is the answer to
"prevented or reconciled, not merely re-queued": **prevented**, with the
synchronous-listener fact of §2.1 as the reason it is checkable.

### 3.2 The user's own settle path

We never force-save. The user may settle the buffer themselves, by the ordinary
means, and then re-request the pause. A convenience action may call the ordinary
non-forced `save-current-block!` **only** on explicit user confirmation, never
automatically, never during composition, and never with `force?`. Whichever way
the edit settles, it flows to disk through the normal path, is observed through
the ledger and causes, is **captured** through the existing capture path, and the
plan, preview and approval are **regenerated** (§4.2).

### 3.3 Korean composition

Never force-end, never discard. `save-current-block!` already returns without
saving while `editor-in-composition?` is true (`editor.cljs:1328`), and the flag
is maintained by the shared textarea wrapper (`ui.cljs:117-130`). `clear-edit!`
(`state.cljs:1244`) and `escape-editing` (`editor.cljs:3742`) would unmount the
textarea whose DOM value is the only truth for text not yet in
`:editor/content`; neither is called by the barrier in any state.

A request during composition enters `deferred`. Admission is **not** closed, so
the user finishes the word normally. Message:

> 입력 중인 한글 조합이 끝나면 적용을 시작합니다.
> Waiting for the current Korean input to finish before applying.

The re-check rides the existing flag change at `ui.cljs:122`; no composition hook
is added and no timer force-ends anything. After
`composition-defer-timeout` the request is abandoned — editing was never
interrupted and nothing was written. Composition ending settles layer 1 only, so
`deferred` transitions to the §3.1 precondition check, never to `applying`.

### 3.4 During the pause

> **Superseded — see §0.2 F5.** The no-mutation invariant does not hold; selected-block operations bypass G1/G2. Recorded, not redesigned; not to be implemented.

G1 refuses entry to edit mode, so no new buffer can be created on any page,
including the transaction's own pages. Together with §3.1's precondition that no
buffer existed at close time, the invariant for the whole blocked window is:
**no editor buffer exists, and the database is unmodified.** Keystrokes reach
nothing; the UI says so.

---

## 4. The state machine

An explicit **"Apply pending changes"** command. Bounded; every state below
names its exit and its bound.

| State | Admission | Helper authorized | Exit | Bound |
|---|---|---|---|---|
| `idle` | open | no | user requests a pause | — |
| `deferred` | **open** | no | composition ends → `checking`; timeout → `idle` | `composition-defer-timeout` |
| `checking` | closing | no | §3.1 preconditions → `draining`; any failure → `resuming` | immediate |
| `draining` | closed | no | §2.4 all three → `base-validating`; expiry → `resuming` (`drain-incomplete`) | `drain-timeout` |
| `base-validating` | closed | no | stable two-read of every transaction path (`stableRead`, `incoming-application.js:172`) against the accepted records | `validate-timeout` |
| `awaiting-approval` | closed | no | approve → `authorizing`; reject or expiry → `resuming` | `approval-timeout` |
| `authorizing` | closed | **being granted** | authorization issued → `applying` | immediate |
| `applying` | closed | **yes** | all files written and verified → `reconciling` | §5.2 |
| `reconciling` | closed | revoked | per-file `reconcile!` (`incoming-application.js:270`) → `verifying` | §5.2 |
| `verifying` | closed | revoked | `revalidateIntendedState` + a later database sample → `resuming` | §5.2 |
| `held-unresolved` | **closed, or per-path** | unknown | §5.3 | user action |
| `resuming` | reopening | no | → `idle` | immediate |

The boundary between `awaiting-approval` and `authorizing` is the boundary
between §5's two regimes and is the most important line in the design.

### 4.1 `awaiting-approval` is pre-write

No helper authorization exists yet, so an expiry here is a clean cancellation:
nothing was written, nothing can have been written, and admission reopens safely.
This is the only state that waits on a human, and it is deliberately placed
entirely inside the safe regime.

### 4.2 Approval comes after the drain

Draining is the only stage that can change the accepted base by design — it
flushes the user's own settled edit to disk. A proposal approved beforehand is
stale by construction. So: drain → validate base → generate preview → approve.
If the drain changed the base, the change is captured, the plan and preview are
recomputed, and a fresh approval is required. `planIncoming`'s `unknown-base`
refusal is retained as a second check, because the barrier is cooperative and
§1.2's writers can still move a file.

`approved.runtimeMode` gains a third value, `app-paused`, persisted in the hashed
approval-bound half exactly as `app-closed` and `app-idle` are, so approvals
cannot cross modes.

### 4.3 Deadlock: reconciliation writes into the channel G3 closes

> **Superseded — see §0.2 F5.** No rule distinguishes a prohibited local mutation from a required reconciliation one at G3. Recorded, not redesigned; not to be implemented.

```
reconcile-from-disk!            watcher_handler.cljs:45
  → set-missing-block-ids!      watcher_handler.cljs:29
    → batch-set-block-property! handler/editor/property.cljs:76
      → outliner-tx/transact!   (no :from-disk?, so invoke-hooks runs)
        → updated-page-hook     outliner/pipeline.cljs:111
          → sync-to-file        outliner/file.cljs:86   ← G3
```

If the barrier is engaged during `reconciling`, these writes to **other pages**
are refused and never settle, so the transaction cannot converge and the pause
cannot release. The first slice makes this unreachable: `planIncoming` refuses
`block-reference-in-payload` for any payload containing `((uuid))`, matched with
OG's own `block-ref/get-all-block-ref-ids` (`watcher_handler.cljs:33`). The
refusal is on **payload shape**, not graph state, because whether a referenced
block currently lacks `id::` is only knowable at reconcile time. It refuses some
harmless payloads; that is the correct direction for a first slice.

---

## 5. Timeout and crash semantics

### 5.1 Pre-write cancellation (`deferred`, `checking`, `draining`, `base-validating`, `awaiting-approval`)

No helper authorization has been issued, so no writer can start. Expiry, refusal
and user cancellation all reopen admission immediately. This is safe without any
proof about an external process, because there is nothing external to prove.

### 5.2 Post-write uncertainty (`authorizing`, `applying`, `reconciling`, `verifying`)

> **Superseded — see §0.2 F1.** Step 2's expiry branch has no counterpart in the helper protocol. Recorded, not redesigned; not to be implemented.

From the moment authorization is issued, a helper write may be in progress. A
renderer timeout **cannot** release admission here: the renderer has no way to
observe the helper, and the retained journal constrains the coordinator, not OG's
writer.

Required, in order:

1. **Stop further application.** No new file is authorized.
2. **Establish writer termination or revocation** — one of:
   - the coordinator explicitly reports completion or abort through the request
     channel (normal path); or
   - the authorization's own expiry has passed by more than the allowed clock
     skew, so no helper operation can still be consuming it. The authorization
     therefore carries a short, explicit lifetime, and the renderer's bound is
     derived from it rather than chosen independently.
3. **Preserve recovery evidence.** The journal, before-images and the
   authorization record are untouched.
4. **Reconcile before affected writes resume.** OG must hold the on-disk bytes
   for each affected path — via the ordinary watcher path, confirmed by
   `db/get-file` — before that path is writable again.

**Admission reopens per path, not globally.** Once termination is established,
editing of unaffected pages resumes; each transaction path stays write-blocked
until step 4 holds for it. This is finer-grained and materially safer than
revision 1's all-or-nothing release.

### 5.3 `held-unresolved`: a bounded escape, not a lockout and not a silent release

> **Superseded — see §0.2 F2.** The escape is an unapproved risk override, not evidence of safety. Recorded, not redesigned; not to be implemented.

If the coordinator is silent past the derived bound and the authorization has
**not** provably expired, the renderer cannot establish termination. It must not
guess in either direction, so it does neither:

- it does **not** auto-resume writes to affected paths;
- it does **not** lock the application. Unaffected pages remain editable, and the
  state is displayed with its reason.

The escape is the user, who is the authority the renderer lacks: an explicit,
confirmed **"Resume editing these files anyway"** action. Taking it is recorded,
marks the transaction unresolved, and refuses further application until recovery
runs. Not taking it costs the user nothing but those files.

So: no unexplained permanent lockout, no silent release during an unresolved
application, and no dependence on the renderer proving something it cannot.

### 5.4 Process kill

> **Superseded — see §0.2 F1, F2, F6.** The expiry lapse contradicts §5.2, and the marker has no approved schema, no dedicated target, no lifecycle and no restart-ordering contract. Recorded, not redesigned; not to be implemented.

**A renderer kill destroys any unsaved DOM buffer.** Revision 1 implied
otherwise; that is withdrawn. The pause neither improves nor worsens OG's
existing behaviour here, and **no buffer-persistence mechanism is designed in
this document**. If buffer survival across a kill is wanted, it is a separate
design.

The barrier itself is renderer memory and does not survive. That is unsafe on its
own, because a restarted renderer would happily write to a path the helper may
still be operating on. So a restart needs a durable, **fail-safe** signal:

**A per-path marker**, written by the coordinator through the existing helper
into the graph directory, naming the transaction's affected paths and the
authorization expiry. On graph load OG reads it — an ordinary graph-file read,
needing no new permission — and applies §5.2's per-path block with the same
`held-unresolved` presentation and the same user escape. `recoverIncoming`
clears it. Once the recorded expiry has passed, the block lapses to an advisory
notice naming the files to verify.

It is a non-note file in the graph, so it is excluded from note-hash assertions
and is inventoried explicitly (§6, §8). It is new, and it is an approval item.

| Kill during | State on disk | On restart |
|---|---|---|
| `deferred`, `checking`, `draining`, `base-validating`, `awaiting-approval` | nothing written | no marker exists; ordinary editing; approval discarded; preview regenerated |
| `authorizing`, `applying` | a file may be written | marker present → affected paths blocked, others editable; `recoverIncoming` resolves |
| `reconciling`, `verifying` | written, publication unproven | marker present; recovery re-runs the reconciliation wait for every file, as accepted |

---

## 6. What is controlled, what is inert, what is outside

> **Partly superseded — see §0.2 F4, F5.** The "Controlled" row's coverage is
> **unestablished**. The inert and outside rows, and the cooperative-barrier
> statement, stand.

The review is right that `EXPECT` plus publication checks do not reliably detect
the paths in §1.2. `revalidateIntendedState` (`incoming-application.js:1066`)
iterates only `approved.files` and `approved.unchanged` — an enumerated set — and
`checkNotePath` (`:119`) admits only direct-child `.md` files under `pages/` and
`journals/`. A file created that was never in the accepted snapshot is not
examined. `logseq/bak/<page>/<ISO>.Desktop.md` is three levels deep and is not
even representable. `stableRead` (`:172`) is two reads that can agree on the same
intermediate state. These are mitigations with known race gaps, not detection.

| | Mechanism | Coverage |
|---|---|---|
| **Controlled — UNESTABLISHED, see §0.2 F4 and F5** | G1/G2/G3 + the ledger + causes | claimed: outliner-originated writes to `pages/*.md` and `journals/*.md` in this renderer, for this repo. The gates do not cover direct outliner transactions and the ledger is not an exact ownership record, so this coverage is **not established** and is not a guarantee |
| **Inert in the synthetic setup — asserted, not assumed** | plugins: no native plugin loaded, marketplace and installation refused (`f28-origin/NETWORK_CONTROL.md`); file-sync: network and Electron `net` refused, no account enrolled; PDF assets, drawings, whiteboards, global/plugin config: not exercised by the experiment | each asserted at run start: plugin count zero, sync inactive, and an inventory showing no writes under these paths |
| **Outside the guarantee — mitigated only, with known race gaps** | asset IPC (`handler/editor.cljs:1451`); main-process backups and version files; `unlink`/`copyFile`; a second OG window via `dbsync` (`db.cljs:127-141`); Finder, cloud agents, external editors, `git`, a second instance | helper `EXPECT` recheck before `renameat`; per-file hash revalidation for enumerated notes only; an explicit inventory of every extra `.md` |

**Cooperative barrier versus exclusion.** The barrier makes OG's own write paths
that consult it decline to start new work. It excludes nothing: it is not a file
lock, not advisory locking, not `flock`. For comparison: `app-closed` excludes
exactly one application by proving it exited; `app-idle` excludes nothing and
reports evidence; `app-paused` excludes nothing either — it suppresses one
renderer's cooperating write paths. Every result names its mode.

---

## 7. Actual scope

Revision 1 claimed five seams. A pause whose central guarantee is resolved needs
twelve, and this is stated rather than minimized.

| # | Seam | Location | Note |
|---|---|---|---|
| H1 | barrier state: request / release / query, per repo | `og_sync_bridge.cljs` | must **not** reuse `blocked?`/`block-runtime!` (`:82`, `:86`) — that latch is fatal, unreleasable, and suppresses `emit!` (`:122`), which the drain depends on |
| H2 | G1: refuse entry to edit mode | `state/set-editing!` `state.cljs:1921` | single chokepoint, four call sites |
| H3 | G2: refuse the commit | `editor.cljs:1328` | one disjunct in the existing `when-not`; precedent is `:editor/skip-saving-current-block?` (`state.cljs:146`, set at `handler/code.cljs:16`), which cannot be reused because it is one-shot and cleared at `editor.cljs:1360` |
| H4 | G3 + ledger registration, including the `:graph/importing` direct-write branch | `outliner/file.cljs:86-97` | |
| H5 | ledger registration at re-queue; retirement at all three terminal branches | `outliner/file.cljs:54-70` | |
| H6 | bind the admission token around `save-tree!` | `outliner/file.cljs:60-70` | **universal save path** |
| H7 | capture the token before the `p/let`; pass it in options | `handler/file.cljs:203-213` | **universal save path** |
| H8 | open the cause under `enabled?`, not only `observation-only?`; accept the token | `fs.cljs:93-101` | **universal save path** |
| H9 | `:flush-now-ch` into the existing `<ratelimit` | `outliner/file.cljs:101`; `util.cljc:1174`, `:1190-1194` | machinery already exists |
| H10 | request channel: a **write** call on an API that is currently read-only (`og_sync_bridge.cljs:140`, `:250-265`) | new `ENABLE-OG-BRIDGE-BARRIER` define | real new authority |
| H11 | durable per-path marker: written by the coordinator through the helper, read by OG at graph load, cleared by recovery | new graph artifact + read at load | **F6: undesigned.** An anchored graph-local write path already exists (`write-record` with `target: sidecar` publishes into `logseq/.og-sync`), so the obstacle is not the absence of a write path. What is missing is an approved marker schema, a dedicated target (the existing ones are bound to identity/recovery records and must not be repurposed), a lifecycle, and a restart-ordering contract. Whether a future design extends a command, adds a target or adds a command is **open** |
| H12 | `held-unresolved` presentation and the confirmed user escape | new UI | new UI |

All are behind the existing `ENABLE-OG-SYNC-BRIDGE` define
(`og_sync_bridge.cljs:15`, default false) and deliberately **not** under
`ENABLE-OG-BRIDGE-OBSERVATION` (`:16`), so the accepted observation-only package
stays byte-identical and truthfully observation-only.

**H6, H7 and H8 sit in the path every save in the product takes.** H8 in
particular changes which builds open a cause. That is the risk concentration, and
it is why §9 recommends what it does.

### 7.1 Explicitly not required

No new Electron IPC channel or main-process handler. No generic renderer
filesystem access — note bytes are still written only by the anchored helper,
outside the application, and H11's marker is read by OG as an ordinary graph
file. No helper or process-execution permission from the renderer; child-process
launches and utility-process forks stay refused. No network permission. No
change to `pilot/guard-source!` / `guard-fs!` (`electron/handler.cljs:94-110`).

---

## 8. Test plan

Central safety conditions are **mandatory**. Nothing below may be reported as
"unverified but accepted".

### 8.1 Reused unchanged

`incoming-application.test.js` (64/64), `probe-binding-check.js` (15/15,
supervisor-verified), `isolation-check.js` (42/42), and the pure suites. Baseline
and platform validation are **not** repeated.

### 8.2 CLJS unit tests — the ledger and the gates

In the existing `src/test/frontend/fs/og_sync_bridge_test.cljs`:

1. Ledger: register on admission; retire on each of `do-write-file!`'s three
   terminal branches; the drain condition is false while any entry is unretired.
2. Re-queue termination: with no block in edit mode, `input-idle?` is true and the
   long-page branch stops; `whiteboard-idle?` goes true after its interval. The
   re-queue cap refuses `drain-requeue-limit`.
3. Ownership transfer: the entry retires only when the cause opens; a write held
   in the microtask gap keeps the drain false.
4. `drain-timeout` **refuses**; there is no path by which expiry passes.
5. G1 and G2 refuse while paused; the database is not mutated.
6. The barrier is distinct from the `blocked` latch in both directions.
7. A completed cause with no write (the `:file/not-matched-from-disk` branch)
   is not counted as bytes written.

### 8.3 Node tests

New `f28-sync-prototype/tests/editing-pause.test.js`: every transition in §4;
each §3.1 precondition refusing; the composition deferral; `base-changed`
regeneration; and each of §5.1, §5.2 and §5.3 reaching its required outcome.

### 8.4 Live cases — one Intel host, synthetic, each mutating case on its own owned run

> **Superseded — see §0.2 F3.** Mandatory cases 4 and 5 contradict each other. Recorded, not redesigned; not to be implemented.

| # | Case | Mandatory assertion |
|---|---|---|
| 1 | Unsaved text present at request | **refuses `unsaved-buffer-present`; nothing written; buffer intact.** (Revision 1's version of this case is withdrawn as unsafe.) |
| 2 | User settles the edit, then re-requests | the edit is captured, the base advances, the old approval refuses `unknown-base`, a recomputed preview and fresh approval apply |
| 3 | Korean composition active at request | `deferred` with the bilingual message; never force-ended; composition ends; preconditions re-checked |
| 4 | **Queued save present at request** | the ledger is non-empty and the request **refuses `local-work-pending`**. This is now a positive assertion about a tracked object, not a race to catch through the automation channel — which is why it is mandatory and why the ledger earns its cost. |
| 5 | **Drain with a genuine in-flight write** | admission closed with one write already dispatched; the drain waits until the ledger is empty and the cause closed, then passes. Assert the drain did **not** pass earlier. |
| 6 | Typing during the pause | G1 refuses edit-mode entry; the database is unmodified throughout; on resume the page is editable and its file matches the applied content |
| 7 | Failed save present | refuses `failed-local-write`; nothing written; editing resumes at once |
| 8 | Pending rename | refuses `unfinished-local-write` |
| 9 | Block-reference payload | refuses `block-reference-in-payload` at plan time; the §4.3 deadlock is unreachable |
| 10 | `approval-timeout` | clean pre-write cancellation; nothing written; admission reopens |
| 11 | **Coordinator killed during `applying`** | per-path block holds; unaffected pages remain editable; no auto-resume of affected paths; `held-unresolved` is displayed with its reason |
| 12 | **Renderer killed during `applying`** | on restart the H11 marker blocks affected paths only; unaffected pages editable; `recoverIncoming` completes; **no claim that the unsaved buffer survived** |
| 13 | Authorization expiry, coordinator silent | termination established by expiry alone; affected paths reconcile; admission reopens per path |
| 14 | Setup assertions | plugin count zero; sync inactive; inventory shows no writes under the §6 inert paths |
| 15 | Feature off | editing, saving, renaming and reopening behave exactly as before; barrier symbols absent from the build |

Per-file exact hashes for every accepted file, plus an explicit inventory of every
extra file: each must be under `logseq/bak/`, `logseq/version-files/local/`, or
be the H11 marker.

---

## 9. Recommendation

**Retain the accepted app-closed path for the next prototype. Do not build the
pause yet.** — **Accepted by the supervisor, 2026-09-16 (§0.1).**

| | App-closed (accepted) | Pause, with §1–§7 resolved |
|---|---|---|
| Application code | none | twelve seams, three of them (H6, H7, H8) in the path every save in the product takes |
| New artifacts | none | a durable in-graph marker (H11) and new UI (H12) |
| New authority | none | a write call on a read-only API (H10) |
| Data safety | strongest available; not exclusion | better than `app-idle`; worse than `app-closed`; still excludes nothing (§6) |
| Usefulness | low — the user must quit to receive a change | receive a change without quitting |

Revision 1 recommended building the pause on the basis that it cost five seams
concentrated behind a default-off define. That basis does not survive the review.
The honest cost is roughly two and a half times larger and is concentrated in
OG's universal save path, and two of the twelve seams are things this project has
not built before at all — a durable in-graph coordination marker and a
user-facing unresolved-state escape.

Against that, the accepted app-closed path already delivers the safety the pause
is reaching for, and delivers it more strongly.

### If the pause is wanted anyway, build it in this order

The completion tracking is worth building **on its own**, before any barrier:

- **M1 — the ledger and cause coverage (H4, H5, H6, H7, H8, H9).** Note: §0.2 F4
  shows the ledger as specified is not an exact ownership record, so M1 is a
  direction, not a ready design. No barrier, no pause, no new authority, no new
  UI. It is aimed at the gap the accepted results record as open — *"genuine
  pending-save capture is not established"* — by replacing a race to be caught
  with an object to be read. Whether it closes that gap depends on first
  resolving F4; it is not claimed to close it as specified. If M1 cannot be made
  sound, the pause cannot be either, and that is found out before any authority
  is taken.
- **M2 — the gates and the state machine (H1, H2, H3, H10).**
- **M3 — durable restart semantics and the escape (H11, H12).**

Attempting M2 without M1 is precisely what revision 1 did, and it produced a
mechanism that looked like a barrier and behaved like an idle window.

**An unenforced idle window remains not a third option.** The accepted contract
already records that its signals are evidence rather than exclusion, and
repeating it changes nothing about that.

## Limitations

1. The barrier would be cooperative and would exclude nothing (§6).
2. §1.2's paths bypass it, including a second OG window on the same graph.
3. Completion tracking covers outliner-originated writes only; assets,
   main-process writes and a second window are outside it (§2.5).
4. A completed cause does not prove bytes were written (§2.5).
5. Publication checks cover an enumerated set of `pages/*.md` and
   `journals/*.md`; new files and non-note files are not covered (§6).
6. Check-then-write gaps remain on both sides. Interleaving is narrowed, neither
   prevented nor reliably detected.
7. An unsaved buffer does not survive a process kill, and no mechanism for that
   is designed here (§5.4).
8. **Concurrent-edit safety is not established by this design.** Fully built and
   passing, it would establish safety for a short, explicit, user-initiated pause
   under the §6 setup assumptions — not for continuous concurrent editing.

## Acceptance criteria — NOT IN FORCE

> **Recorded, not in force.** These were revision 2's proposed criteria. Criteria
> 4, 5 and 6 depend on mechanisms that §0.2 F1, F3 and F4 show are not sound as
> specified. Nothing below was run, and nothing below may be cited as a
> verification plan for an approved slice.


1. Live cases 1–15 pass, each mutating case on its own fresh owned run.
2. No editor buffer is lost, cleared or force-saved in any branch, and no Korean
   composition is ever force-ended.
3. The database is provably unmodified for the whole blocked window (case 6).
4. The drain passes only on §2.4's three positive conditions. `drain-timeout`
   refuses in every test that reaches it.
5. Case 4 and case 5 both pass. Neither may be reported as unverified.
6. No admission reopens to an affected path during `applying`, `reconciling` or
   `verifying` without §5.2's step 2 and step 4, or the recorded user escape.
7. No case reaches a permanent lockout, and no case silently auto-releases during
   an unresolved application.
8. Case 14's setup assertions pass, so §6's "inert" column is asserted evidence.
9. Every result names `mode: app-paused`; no paused run is described in
   `app-closed` or `app-idle` terms in either direction.
10. Results state plainly that concurrent-edit safety in general is not claimed.

## Decisions requiring user approval — WITHDRAWN

> **This list is closed.** The supervisor accepted deferral (§0.1), so none of
> the items below is an open decision. They are retained as the record of what
> a pause would have required. A future in-application barrier needs a new scope
> decision that begins from the §0.2 findings.


1. **Whether to proceed at all**, given §9's recommendation to retain app-closed.
2. If proceeding: **the M1/M2/M3 ordering**, and whether M1 may be approved alone.
3. **H6/H7/H8 in the universal save path**, including H8 changing which builds
   open a bridge cause.
4. **H10**: a write call on a currently read-only API.
5. **H11**: a durable non-note marker file inside the graph, written through the
   helper and read by OG at load.
6. **H12**: a user-confirmed escape that resumes writes to affected paths and
   records that it happened.
7. **Refusing block-reference payloads** in the first slice (§4.3), accepting that
   some harmless payloads are refused to make the deadlock unreachable.
8. **The `app-paused` runtime mode** as a third persisted, approval-bound value.

**This proposal is closed as deferred (§0.1).** Nothing in it is started, and
nothing in it is to be implemented. A future in-application barrier requires a
new scope decision beginning from the §0.2 findings.

한국어 실험 요약은
[`F28_ROADMAP_SUMMARY_KO.md`](../F28_ROADMAP_SUMMARY_KO.md)에 있습니다.
프로젝트 전체의 권위 있는 로드맵은 저장소 바깥의 사용자 문서
`project-notes/PROJECT_ROADMAP_KO.md`입니다.
