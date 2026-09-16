# A controlled editing/save pause for applying one incoming change

Status: **proposal only**, 2026-09-16. Nothing here is implemented, approved or
run. Written from source and documentation review; no graph, profile, helper or
application was touched.

This is option **B** of
[APP_RUNNING_INCOMING_DESIGN.md](./APP_RUNNING_INCOMING_DESIGN.md) — the "real
temporary editing/save barrier" that design deliberately deferred. It is written
now because the accepted idle-app observation milestone has extracted what
observation can give, and the missing ingredient for the next step is **control,
not more measurement**.

## What this builds on, and what it does not touch

| Milestone | Status | This design's relationship |
|---|---|---|
| App-closed incoming application ([INCOMING_CHANGE_DESIGN.md](./INCOMING_CHANGE_DESIGN.md)) | accepted | reused unchanged; kept as the supported fallback |
| Graph-binding correction (`8cd6662c3`) | accepted | its three-identity discipline is mandatory here |
| Limited idle-app observation findings | accepted | reused; its gate, hook and mode discipline are extended, not replaced |
| Complete live observation matrix | **not accepted as finished** | not continued, not assumed, not cited as passing |
| Concurrent-edit safety | **unverified** | still unverified after this design; this is a proposal |

Nothing below converts injected records, synthetic `CompositionEvent`s,
same-process `recoverIncoming` calls or simulated secondary writes into claims
about real integration. Where this design depends on one of those, it says so.

## Non-goals

- Not continuous concurrent editing. The pause is short, explicit and
  user-initiated.
- Not a general synchronization service, background sync loop or transport.
- Not incoming rename or delete. Creates and updates only, as accepted.
- Not exclusion of Finder, cloud agents, external editors or a second Logseq
  instance. See §6.
- Not exactly-once. The accepted no-exactly-once position is unchanged.
- Not whole-graph atomicity, power-loss durability or cross-process
  serialization.
- Not a durable barrier. It does not survive a crash and does not claim to (§5).
- One host, synthetic data, no second device, no personal data.

---

## 1. Admission control: which paths must cooperate

An overlay is not a write barrier. A modal that covers the editor stops
keystrokes reaching a textarea and stops nothing else: the outliner queue keeps
draining, plugins keep writing, and the main process keeps writing backups.
Admission control has to sit on the write paths themselves.

### 1.1 The six layers a local edit passes through

| # | Layer | Source | Barrier? |
|---|---|---|---|
| 1 | Keystrokes: DOM textarea value and `:editor/content` | `state.cljs:128`, `state.cljs:920`; the value read at save time is `(gobj/get elem "value")`, `editor.cljs:1343` | **never touched** |
| 2 | Commit into the database | `save-current-block!` `editor.cljs:1322`; `save-block!` `:1298`; `save-blocks!` `:1315` | **gate here (H3)** |
| 3 | Database → file queue | `updated-page-hook` `outliner/pipeline.cljs:12` → `sync-to-file` `outliner/file.cljs:86` → `async/put!` onto `:file/writes` (`state.cljs:34`, buffer 10000) | **gate here (H2)** |
| 4 | Rate limiter | `<ratelimit-file-writes!` `outliner/file.cljs:101`, `batch-write-interval` 1000 ms `:17`, installed once at `handler.cljs:240` | **flush here (H4)** |
| 5 | Write execution | `write-files!` `:73` → `do-write-file!` `:44` → `save-tree!` `modules/file/core.cljs:168` → `alter-files-handler!` `handler/file.cljs:203` → `write-plain-text-file!` `fs.cljs:93` → `write-file-impl!` `fs/node.cljs:22` → IPC `writeFile` | **must NOT be gated** — this is what drains |
| 6 | Cause registration | `save-pending!` `og_sync_bridge.cljs:269` inside `write-file-impl!` | observation only |

The gate is on **entry** (layers 2 and 3), never on **exit** (layer 5). Work
admitted before the pause must be allowed to run all the way to disk, or the
drain in §2 blocks the very writes it is waiting for.

### 1.2 Uncontrolled paths — what a layer-2/3 gate does not reach

These write graph files **without passing through the outliner queue**. Each is
a real bypass of the barrier and is listed so the first slice's boundary is
explicit rather than optimistic.

**Renderer, through `fs/write-plain-text-file!` but bypassing layers 2–4**, most
with `{:skip-compare? true}`, which also skips the disk-compare precondition
entirely (`fs/node.cljs:25-36` — no `readFile`, no
`:file/not-matched-from-disk`):

- Plugin API: `logseq/api.cljs:176`, `:196`, `:328`; `logseq/sdk/git.cljs:28`;
  `handler/plugin.cljs:563`; `handler/plugin_config.cljs:42`, `:49`
- Config: `handler/global_config.cljs:76`; `handler/file.cljs:129`
  (`alter-global-file`)
- `util/persist_var.cljs:69`
- PDF assets: `extensions/pdf/assets.cljs:70`, `:119`
- Drawings: `handler/draw.cljs:32`
- `handler/events.cljs:901`
- File-sync merges: `fs/sync.cljs:1598`, `:1648`, `:1675`

**Renderer, bypassing `fs.cljs` altogether** — no bridge cause exists at all:

- Asset writes: `ipc/ipc "writeFile"` at `handler/editor.cljs:1451`

**Main process, never initiated by the renderer write path:**

- `:backupDbFile` → `logseq/bak/**` (`electron/handler.cljs:94`,
  `backup_file.cljs:7`, `:19`, pruning at `:27`)
- `:addVersionFile` → `logseq/version-files/local/**`
  (`electron/handler.cljs:118`)
- `unlink`, `rename`, `copyFile` (`fs/node.cljs:105`, `:128`, `:131`). Rename
  has a bridge cause (`handler/page.cljs:221`); unlink and copy have none.

**Outside the process entirely:** Finder, iCloud/Dropbox agents, an external
editor, `git checkout`, a second Logseq instance. No in-app flag reaches any of
them.

### 1.3 The first slice's boundary

The barrier covers layers 2–4 for note files under `pages/` and `journals/` —
the same `ALLOWED_PARENTS` the accepted applier enforces
(`incoming-application.js:44`). Everything in §1.2 is **outside** the barrier
and is handled as it already is: **detected, not prevented**. The accepted
applier refuses `unrelated-local-change` at publication when a file outside the
transaction diverges from its accepted hash, and the anchored helper rechecks
`EXPECT` immediately before `renameat`. The barrier narrows the window; those
two checks are what actually protect bytes.

---

## 2. Existing work: draining queued and in-flight saves

### 2.1 There is currently no completion signal, and this is the core problem

- `*writes-finished?` (`outliner/file.cljs:99`, `:107-112`) marks **dispatch**.
  The flush function calls `write-files!` and then sets `{:value true}`.
- `write-files!` (`:73-82`) runs `do-write-file!` inside a `doseq` and discards
  each returned promise.
- `save-tree-aux!` (`modules/file/core.cljs:164`) calls `alter-files-handler!`
  and discards its promise, although `alter-files-handler!`
  (`handler/file.cljs:203-236`) genuinely returns one built from `p/all`.
- Its absence for a repo is `nil`, not `true`.

So nothing in OG today can answer "has every queued save landed?". The **only**
real completion evidence in the process is the bridge cause lifecycle:
`save-pending!` (`og_sync_bridge.cljs:269`) → `save-completed!` (`:301`) /
`save-failed!` (`:305`), and `rename-intent!` (`:309`) → completed / failed.
Those wrap the actual IPC call in `write-file-impl!` (`fs/node.cljs:26`, `:58`),
`fs.cljs:99-117` and `fs/nfs.cljs:55-67`.

### 2.2 The drain, in order

1. **Close admission** (H2, H3). New commits and new queue entries for the owned
   repo are refused and recorded as deferred pages. Layer 5 is untouched.
2. **Flush immediately.** `<ratelimit` already implements a flush-now channel
   (`util.cljc:1174`, `:1190-1194`); `<ratelimit-file-writes!`
   (`outliner/file.cljs:101-115`) supplies none. Passing one is the entire
   mechanism — no new machinery, and it removes the 1000 ms wait from the
   critical path.
3. **Await cause closure.** Every cause for the owned `ogRepo` must be closed.
   Then observe a stability window: no new cause appears and none is pending
   across a window longer than `batch-write-interval`, repeated to a bounded
   limit.

Step 3 is strictly stronger than the accepted `observeSettled`
(`og-idle-probe.js`), because admission is closed: "nothing new surfaced" can no
longer be defeated by a save arriving a moment later **on a path that consults
the barrier**. It remains defeated by §1.2's paths, and that limit is stated in
the results, not glossed.

**The honest gap that remains.** A cause only exists after `write-file-impl!`.
A write already in flight between `alter-files-handler!` and `write-file-impl!`
has no cause yet, so the stability window — not the cause count — is what covers
it. That window is evidence, not proof, and the design says so.

### 2.3 Failed saves

`save-failed!` closes a cause as `:failed`, not `:pending`
(`og_sync_bridge.cljs:305`), so a pending-only check passes straight over it
while the database holds new content and disk holds whatever the failure left.
The accepted idle gate already refuses on failed causes; the pause keeps that.

A failed cause on the owned repo, on any path, during the pause window is a
**refusal** (`failed-local-write`). The pause does not retry OG's save, does not
clean up after it and does not apply. It **resumes editing immediately** and
reports the failure. Editing is never held hostage to a failure the pause did
not cause and cannot fix.

### 2.4 Pending renames

`rename-intent!` is opened **after** the database transact
(`handler/page.cljs:212-218` then `:221`), so the database already holds the new
path while disk still holds the old one. `unfinished-local-write?`
(`og_sync_bridge.cljs:348`) and `register-incoming-cause!` (`:360`) already
refuse on this as `unfinished-local-write`.

The first slice refuses on **any** rename cause for the owned repo that is not
completed at the start of the pause, not only ones intersecting the
transaction's paths, because a rename that lands mid-pause invalidates the
before-image path binding the approval was issued against.

---

## 3. Korean composition

**Never force-save an active composition and never discard one.**

- `save-current-block!` already returns without saving while
  `editor-in-composition?` is true (`editor.cljs:1328`, `state.cljs:1710`).
  Forcing past that guard commits a half-assembled jamo sequence.
- Composition state is set by the shared textarea wrapper: `compositionstart` /
  `compositionupdate` set it true, `compositionend` sets it false and then fires
  `on-change` (`ui.cljs:117-130`).
- `clear-edit!` (`state.cljs:1244`) and `escape-editing`
  (`editor.cljs:3742`) end the current edit. Either would unmount the textarea
  whose DOM value is the only truth for text not yet pushed into
  `:editor/content`. Neither is called by the barrier, in any state.

**Design: defer, do not refuse and do not force.** A pause requested while
`editor-in-composition?` is true enters `deferred`. Admission is **not yet
closed**, so the user can finish the word normally. The message is explicit in
both languages:

> 입력 중인 한글 조합이 끝나면 적용을 시작합니다.
> Waiting for the current Korean input to finish before applying.

The request re-checks on the existing state change (`ui.cljs:122` already sets
the flag false at `compositionend`); no new event and no composition hook is
added. After `composition-defer-timeout` with composition still active, the
request is **abandoned** as `deferred-composition-timeout` — editing was never
interrupted and nothing was written. No timer ever force-ends a composition.

Composition ending does not mean the text has reached disk: it means layer 1 is
settled. `deferred` therefore transitions to `draining` (§4), never directly to
`applying`.

---

## 4. States and transitions

A short, explicit **"Apply pending changes"** command. Not a background service.

```
                    ┌──────────────── (timeout / refusal / completion) ───────┐
                    v                                                         │
  idle ──request──> deferred ──composition ends──> draining ──ok──> base-validating
   ^                   │                              │                  │
   │           defer-timeout                     drain-failed            ├─ base unchanged ──> awaiting-approval
   │                   │                              │                  └─ base changed ──> capture + recompute
   └───────────────────┴──────────────────────────────┘                          (regenerate preview) ──> awaiting-approval
                                                                                            │
   idle <──resuming<── verifying <── reconciling <── applying <────approve─────┘
                          │                                              │
                          └── verification failed ──> held ──(bounded)──> resuming
```

| State | Entered when | Editing | Exit |
|---|---|---|---|
| `idle` | default | normal | user requests a pause |
| `deferred` | composition active, or an editor action is open (`state/get-editor-action`, guarded at `editor.cljs:1331`) | **normal — admission not yet closed** | composition ends → `draining`; timeout → `idle` |
| `draining` | admission closed, flush-now issued | blocked | all causes closed + stable window → `base-validating`; failed/pending/timeout → `drain-failed` |
| `drain-failed` | §2.3 / §2.4 / timeout | — | always → `resuming`, nothing written |
| `base-validating` | drain complete | blocked | stable two-read of every transaction path (`stableRead`, `incoming-application.js:172`) compared against the accepted records |
| `awaiting-approval` | preview generated | blocked | approve → `applying`; reject or `approval-timeout` → `resuming` |
| `applying` | approval bound | blocked | one approved transaction; helper `EXPECT` + `renameat` per file |
| `reconciling` | each file verified on disk | blocked | the accepted `reconcile!` port awaited per file (`incoming-application.js:270`) |
| `verifying` | all files reconciled | blocked | `revalidateIntendedState` + a later database sample at the completion boundary, per the accepted contract |
| `held` | verification failed **and** an open buffer targets a path where disk and database disagree | blocked | bounded; then `resuming` with a report |
| `resuming` | any terminal branch | reopening | deferred pages re-queued exactly once; admission reopened |

### 4.1 Approval comes **after** the drain

This is the one ordering change from the idle-app design, and it is deliberate.

Draining is the only stage that can change the accepted base *by design*: it
flushes the user's own pending edit to disk. A proposal approved before the
drain is stale by construction. So the sequence is drain → validate base →
**then** generate the preview and obtain approval. The user approves the preview
that actually applies.

If the drain changed the base, the change is **captured through the existing
capture path** so the records advance, the plan and preview are **recomputed**,
and a **fresh approval** is required. `planIncoming` already refuses
`unknown-base` when an old approval is replayed against a moved base, and that
refusal is retained as a second check at apply time — because the barrier is
cooperative and §1.2's paths can still move a file between validation and
application.

`approved.runtimeMode` (accepted, persisted in the hashed approval-bound half)
gains a third value, `app-paused`. An approval issued for one mode cannot apply
in another, exactly as `app-idle` and `app-closed` cannot cross today.

---

## 5. Failure and restart

### 5.1 What is preserved

- **The editor buffer.** No transition calls `clear-edit!` or `escape-editing`.
  The buffer survives because H3 declines to save — precisely the behaviour the
  existing composition guard already has (`editor.cljs:1328`): leave the value
  in the textarea and return.
- **Before-images and the open journal.** Unchanged from the accepted slice:
  retained before-images, whole-transaction preflight, roll-forward-only
  recovery, and "a missing record is never success".
- **Deferred pages.** Every page refused at layer 3 during the pause is recorded
  and re-queued exactly once on `resuming`. Refusing the `async/put!` leaves the
  database ahead of the file — the same state OG already reaches at
  `:file/not-matched-from-disk` (`fs/node.cljs:55`) and at any crash — and
  re-queueing is what repairs it.

### 5.2 The lockout problem, and why the barrier is deliberately non-durable

Two facts pull in opposite directions:

- If the barrier lives only in renderer memory, a reload clears it. That is
  **fail-open**: editing resumes, possibly while a transaction is half applied.
- If the barrier were made durable, a coordinator crash would leave editing
  blocked forever with nobody to release it.

**Resolution: a non-durable, fail-open barrier plus a durable, fail-closed
journal.** They protect different things.

- **Editing always resumes on restart.** There is no state in which OG comes up
  unable to edit. Every blocked state also carries its own bounded timeout, so
  there is no unexplained permanent lockout even without a restart.
- **Application is what stays blocked.** The retained journal already refuses a
  second proposal per owned run until `recoverIncoming` resolves it. That is the
  accepted mechanism and needs no change.

| Restart during | Disk/database state | On restart |
|---|---|---|
| `deferred` / `awaiting-approval` | nothing written | editing normal; approval discarded; preview must be regenerated |
| `draining` | queued saves may or may not have landed | editing normal; the next pause re-drains and re-validates the base |
| `applying` | disk may be ahead of the database | editing normal; OG re-reads from disk at graph load — the accepted "written, not reconciled" state; the journal stays open |
| `reconciling` / `verifying` | disk applied, publication not proven | editing normal; `recoverIncoming` re-runs the reconciliation wait for every file, as accepted |

### 5.3 Silent data loss is narrowed, not eliminated

Fail-open means a reload during `applying` lets the user edit a file the helper
is about to rename over. This is **not prevented**. It is detected: the helper
rechecks `EXPECT` immediately before `renameat` and refuses, and the applier
refuses `unrelated-local-change` at publication.

The honest statement is the same one §2 of the app-running design makes: both
sides are check-then-write, interleaving is neither prevented nor reliably
detected, and the barrier narrows the window without closing it. Nothing in this
document claims otherwise.

---

## 6. Authority: the exact new hooks required

All five are behind the existing `ENABLE-OG-SYNC-BRIDGE` goog-define
(`og_sync_bridge.cljs:15`, default false). They are **not** placed under
`ENABLE-OG-BRIDGE-OBSERVATION` (`:16`), because this mechanism suspends work
rather than observing it, and the accepted observation-only package must stay
byte-identical and truthfully observation-only.

| # | Hook | Where | Size |
|---|---|---|---|
| H1 | `request-pause!` / `release-pause!` / `editing-paused?` | `og_sync_bridge.cljs`, a new **releasable** field in the existing runtime atom | new state, ~30 lines |
| H2 | one consultation refusing the `async/put!` for a paused owned repo, recording the page as deferred | `outliner/file.cljs:86` (`sync-to-file`) | one branch |
| H3 | one more disjunct in the `when-not` that already guards composition | `editor.cljs:1328` | one line |
| H4 | pass `:flush-now-ch` to the existing `<ratelimit` and expose it | `outliner/file.cljs:101` | one argument |
| H5 | a renderer-side **write** call so the pause can be requested | the exposed bridge object | see below |

**H1 must not reuse the `blocked` latch.** `blocked?` / `block-runtime!`
(`og_sync_bridge.cljs:82`, `:86`) is a fatal, unreleasable latch that also
suppresses event emission (`emit!` → `invoke-sync-port`, `:96-110`). A barrier
is releasable and must never suppress emission — the drain depends on causes
still being emitted. They are separate fields, and a test asserts neither can
become the other.

**H3 has an exact precedent.** `:editor/skip-saving-current-block?`
(`state.cljs:146`, set at `handler/code.cljs:16`, read at `editor.cljs:1329`)
already skips saving by the same mechanism. It cannot be reused: it is one-shot
and is cleared unconditionally at `editor.cljs:1360`. It does establish that the
shape is acceptable in this code.

**H5 is the one genuinely new capability, and it is an approval item.** The
accepted observation package exposes a strictly read-only API
(`__LOGSEQ_OG_BRIDGE_OBSERVATION__`, `og_sync_bridge.cljs:140`, `:250-265`) with
`read` and `health` only.

- **H5a (recommended):** add `requestPause` / `release` / `status` under a
  separate new `ENABLE-OG-BRIDGE-BARRIER` goog-define, so the observation build
  stays byte-identical when it is false.
- **H5b:** drive the barrier only from an in-app UI command with no coordinator
  channel at all, the app polling a file the coordinator wrote. Safer in
  authority terms, but needs new UI and a polling loop — larger, not smaller.

H5a is real new authority: a page evaluation can now suspend saving. It is
constrained by (a) the graph binding already implemented as
`app-on-another-graph`, refusing unless the live repo is the transaction's owned
graph; (b) a mandatory self-release timeout in every blocked state; (c) the
default-off define.

### 6.1 Explicitly NOT required, and must not be added

- No new Electron IPC channel and no new main-process handler.
- No generic renderer filesystem access. Note bytes are still written **only** by
  the anchored helper, outside the application.
- No helper- or process-execution permission from the renderer. Child-process
  launches and utility-process forks stay refused
  (`f28-origin/NETWORK_CONTROL.md`).
- No network permission. Loopback HTTP and WebSocket stay refused.
- No change to `pilot/guard-source!` / `guard-fs!` main-process containment
  (`electron/handler.cljs:94-110`).

### 6.2 In-app cooperative barrier versus exclusion

**What it is.** A flag that OG's own write paths *consult*. It makes those paths
decline to start new work, and it gives this project its first real completion
signal for work already started.

**What it is not.** It is not a file lock, not an advisory lock, not `flock`.
It excludes nothing. Finder, iCloud/Dropbox agents, an external editor,
`git checkout`, a second Logseq instance, and every OG path in §1.2 are entirely
outside it — including ones inside the same process. Cooperation is voluntary by
construction: any path that does not read the flag is unaffected by it.

For comparison: `app-closed` excludes exactly one application, by proving it
exited. `app-idle` excludes nothing and reports evidence. `app-paused` excludes
nothing either; it *suppresses* one specific application's cooperating write
paths. That is a real improvement over `app-idle` and a real step down from
`app-closed`, and the results must name the mode on every record, as the
accepted contract already requires.

---

## 7. OG reconciliation side effects

### 7.1 The deadlock, precisely

```
reconcile-from-disk!            watcher_handler.cljs:45
  → set-missing-block-ids!      watcher_handler.cljs:29
    → batch-set-block-property! handler/editor/property.cljs:76
      → outliner-tx/transact! {:outliner-op :save-block}
        → updated-page-hook     outliner/pipeline.cljs:12
          → sync-to-file        outliner/file.cljs:86
            → async/put! onto :file/writes   ← the channel H2 closes
```

If the barrier is still engaged during `reconciling`, reconciliation-generated
writes to **other pages** are refused and never flush. The transaction cannot
converge, and the pause cannot release. That is a genuine deadlock, not a
theoretical one.

Three ways out; the first slice takes the third.

1. **Admit reconciliation-originated writes.** Requires an origin tag threaded
   through `outliner-tx`, which does not exist. Much larger than this slice.
2. **Release the barrier before reconciling.** Reopens editing while disk and
   database disagree — exactly what the pause exists to prevent.
3. **Refuse the input.** ✅

### 7.2 The narrow boundary

`planIncoming` refuses `block-reference-in-payload` when the target content
contains any `((uuid))` block reference, matched by the same function OG uses:
`block-ref/get-all-block-ref-ids` (`watcher_handler.cljs:33`).

The refusal is on the **payload shape**, not on graph state. Whether a referenced
block currently lacks an `id::` property is a property of the graph at reconcile
time and is not checkable before the write; the payload's shape is. Refusing on
shape is conservative — it refuses some payloads that would have been harmless —
and that is the correct direction for a first slice.

This also makes the deadlock **unreachable** rather than merely unlikely, which
is why case 7 in §8 asserts it directly.

### 7.3 Writes that go around the barrier and must be inventoried, not blocked

| Effect | When | Path | Barrier interaction |
|---|---|---|---|
| Backup `.md` | only when the diff contains a deletion (`string-some-deleted?`, `electron/handler.cljs:89`, `:113`) — an append-only change writes **none** | main process, `logseq/bak/<page>/<ISO>.Desktop.md` (`backup_file.cljs:7`, `:19`) | none: never passes `sync-to-file`, so it neither blocks nor deadlocks |
| Backup pruning past six versions | as above | `backup_file.cljs:27` | none |
| Version file | `:addVersionFile` | `logseq/version-files/local/**` | none |
| `id::` writes to other pages | block refs in payload | §7.1 | **refused by construction** in this slice |
| Assets, plugin and config writes | any time | §1.2 | outside the barrier; detected at publication as `unrelated-local-change` |

Verification therefore asserts **per-file exact hashes for every accepted file,
plus an explicit inventory of every extra `.md`**, each of which must be under
`logseq/bak/` or `logseq/version-files/local/`. Whole-graph note hash cannot be
asserted unchanged in any case that reconciles an update — that is already
accepted and is unchanged here.

---

## 8. Verification

### 8.1 Reuse, do not repeat

Reused unchanged, not re-litigated: `incoming-application.test.js` (64/64),
`probe-binding-check.js` (15/15, supervisor-verified), `isolation-check.js`
(42/42), and the pure suites (`core`, `planner`, `executor`, `persistence`).
Baseline and platform validation are **not** repeated.

### 8.2 New CLJS unit tests

In the existing `src/test/frontend/fs/og_sync_bridge_test.cljs`:

1. Barrier engage / release round-trip; `editing-paused?` is per-repo.
2. `sync-to-file` refuses and records a deferred page while paused; releases
   re-queue every deferred page **exactly once**.
3. The barrier is distinct from the `blocked` latch in both directions: a
   barrier never suppresses `emit!`; a blocked runtime never presents as a
   releasable barrier.
4. Every blocked state self-releases at its timeout.
5. Graph binding: a pause requested for a repo the app is not on refuses
   `app-on-another-graph`.

### 8.3 New Node tests

A new `f28-sync-prototype/tests/editing-pause.test.js` against a fake OG
surface: every transition in §4, the composition deferral, the `base-changed`
recompute-and-reapprove path, `approval-timeout`, and each timeout resuming.

### 8.4 Live cases — one Intel host, synthetic, no transport

Each mutating case on its **own fresh owned run**, per the accepted constraint of
one incoming transaction per owned run.

| # | Case | Own run | Required outcome |
|---|---|---|---|
| 1 | English update; an open editor with genuinely unsaved text | yes | buffer intact throughout; `save-current-block!` declines; drain completes; applied; reconciled; resumed; the buffer then saves normally |
| 2 | Korean create, Korean path, composition active at request | yes | `deferred` with the bilingual message; composition ends naturally; drain; apply; exact UTF-8 preserved |
| 3 | **Genuinely queued save inside the 1000 ms batch window** | yes | flush-now drains it; exactly one cause opens and closes for that page; if it moved the base, §4.1 applies |
| 4 | Failed save present on the owned repo | shared (no write) | refuses `failed-local-write`; nothing written; **editing resumes immediately** |
| 5 | Pending rename on the owned repo | shared (no write) | refuses `unfinished-local-write`; nothing written |
| 6 | The drain changes the accepted base | yes | edit captured, records advance, old approval refuses `unknown-base`, recomputed preview and fresh approval succeed |
| 7 | Payload containing a block reference | shared (no write) | refuses `block-reference-in-payload` at plan time; nothing written; the §7.1 deadlock is unreachable |
| 8 | Approval timeout | yes | auto-resume; nothing written; buffer intact |
| 9 | Renderer reload while paused | yes | editing resumes; the open journal blocks re-application; **no lockout** |
| 10 | **Genuine process kill during `applying`** | yes | restart resumes editing; no double write; journal open; `recoverIncoming` completes it |
| 11 | Feature off (`ENABLE-OG-SYNC-BRIDGE` false) | shared | editing, saving, renaming and reopening behave exactly as before; assert the barrier symbols are absent from the build |

### 8.5 Cases 3 and 10 are required, not optional — and why

Both close gaps the accepted results record as open.

**Case 3 — genuine queued/in-flight save.** RESULTS.md records that genuine
pending-save capture is **not established**: sampling every 50 ms while driving a
real save caught zero pending causes, because the `save-pending!` →
`save-completed!` window is shorter than the automation channel can reach. The
pause is the first mechanism that can close this, because with admission closed
the window stops being a race. Flush-now also makes a queued item observable
*after the fact*: engage the barrier, then flush, then assert exactly one cause
for that page.

The honest caveat: to construct a *genuinely queued* save the test must still get
a page onto `:file/writes` and engage the barrier within the 1000 ms batch
window, which is the same timing problem in a smaller form. If it cannot be
constructed live, it is recorded as **unverified and the drain's central claim is
narrowed** — not forced with a synthetic signal, which is what the accepted
results already had to do and said so.

**Case 10 — genuine crash and restart.** RESULTS.md records that calling
`recoverIncoming` again in the same process is not a demonstrated crash and
restart, because no process was killed. A real kill is required here, because
§5.2's whole fail-open/fail-closed split is untested otherwise.

**Korean.** The accepted results used synthetic `CompositionEvent`s (OG did
report composition). If a real input method can be driven, case 2 uses it. If
not, the synthetic path runs, is **labelled synthetic**, and the claim is
narrowed to "OG reported composition and the barrier deferred" — never "a real
IME was handled".

---

## Alternative: the pause versus retaining app-closed application

| | App-closed (accepted) | Editing pause (this design) |
|---|---|---|
| Implementation cost | **zero** — already built and accepted | five application seams (H1–H5), a new state machine, ~11 live cases, plus the two hardest untested things in the project (§8.5) |
| Data safety | strongest available: one writer, proven closed, before-images, roll-forward recovery. Still not exclusion of Finder/cloud/external editors | better than `app-idle` (which excludes nothing and asserts idleness from signals the accepted contract itself calls evidence); **worse than app-closed** — cooperative, fail-open on restart, and §1.2's paths bypass it |
| Real technical gain | — | the **drain**: the first genuine completion signal for saves in this project, replacing a dispatch flag (`*writes-finished?`) and a "nothing surfaced" window (`observeSettled`) |
| User usefulness | low: the user must quit Logseq to receive a change | the first thing a user could actually use — receive a change without quitting |

**Recommendation: build the pause as an explicit "Apply pending changes"
command, and keep app-closed application as the supported fallback rather than
replacing it.**

The reasoning: the accepted idle-app milestone has extracted what observation can
give. Its own contract states that concurrent-edit safety is outside it and that
idleness excludes nothing — and no further observation experiment converts that
into safety, because the missing ingredient is control, not measurement. The
pause is the smallest mechanism that supplies control, and its cost is
concentrated in one place, behind a default-off define, rather than spread
through the application. Keeping app-closed as the fallback means the pause never
has to be the only safe path: `recoverIncoming`'s already-accepted explicit
`fallback: 'app-closed'` selection, which requires proven closure, is exactly the
escape hatch.

**The counter-argument, stated fairly.** App-closed is finished and the pause is
not. A supervisor optimizing purely for already-delivered safety should keep
app-closed and stop here; that is a defensible call and this design does not
pretend otherwise. The reason to proceed anyway is that app-closed cannot become
daily-usable by any amount of further work *on app-closed*. The next milestone
requires in-app authority whenever it is taken, and taking it now — bounded to
one command, one transaction and five seams — is cheaper and far more reviewable
than taking it later underneath a general synchronization service.

**An unenforced idle window is not a third option.** It has already been
measured, and the accepted contract records that its signals are evidence rather
than exclusion. Repeating it changes nothing about that, so it is not offered
here as a middle path.

---

## Limitations, stated plainly

1. The barrier is **cooperative and excludes nothing** (§6.2).
2. §1.2's paths bypass it, including several inside the same process.
3. It is **non-durable and fail-open on restart** by design (§5.2); the journal,
   not the barrier, is what stays fail-closed.
4. Check-then-write gaps remain on both sides; interleaving is narrowed, neither
   prevented nor reliably detected (§5.3).
5. The drain's cause-based completion signal does not cover a write in flight
   before `write-file-impl!`; the stability window covers that, and it is
   evidence (§2.2).
6. No exactly-once claim. Reconciliation invocation counts remain UNAVAILABLE.
7. Payloads containing block references are **refused**, not handled (§7.2).
8. Concurrent-edit safety is **not** established by this design. It is a
   proposal. Even fully implemented and passing, it would establish safety for a
   short, explicit, user-initiated pause — not for continuous concurrent
   editing.

## Bounded acceptance criteria

1. Cases 1–11 pass, each mutating case on its own fresh owned run.
2. No editor buffer is lost, cleared or force-saved in any case, including every
   failure and timeout branch.
3. No composition is ever force-ended or discarded; deferral is the only
   behaviour, and it is bounded.
4. No note is written while the pause gate is unsatisfied.
5. Every blocked state has a bounded timeout that resumes editing. No case
   reaches an unexplained permanent lockout, and case 9 proves a reload resumes.
6. Approval is obtained **after** the drain; if the drain changed the base, the
   preview is regenerated and re-approved, and the stale approval refuses
   `unknown-base`.
7. Deferred pages are re-queued exactly once on resume; the database and file
   agree afterwards.
8. Per-file exact hashes hold for every accepted file, and every extra `.md` is
   inventoried under `logseq/bak/` or `logseq/version-files/local/`.
9. Every result names `mode: app-paused`; no paused run is described in
   `app-closed` or `app-idle` terms, in either direction.
10. Case 3's outcome is reported as either genuine or unverified — never
    substituted with a forced signal.
11. Results state plainly that concurrent-edit safety in general is still not
    claimed.

## Decisions requiring user approval

1. **Take in-app write authority at all**, replacing the observation-only
   posture with five cooperating seams behind a default-off define (§6).
2. **H5: the barrier request channel.** H5a (extend the exposed bridge object
   under a new `ENABLE-OG-BRIDGE-BARRIER` define) versus H5b (in-app UI command
   only, no coordinator channel). H5a recommended; both are new authority.
3. **Accept a fail-open barrier with a fail-closed journal** (§5.2) —
   specifically, that editing always resumes on restart even while a transaction
   is unresolved.
4. **Accept that the barrier excludes nothing** and that §1.2's paths bypass it.
5. **Refuse block-reference payloads in the first slice** (§7.2), accepting that
   this refuses some harmless payloads to make the §7.1 deadlock unreachable.
6. **Require a genuine process kill (case 10) and a genuine queued save
   (case 3)**, accepting that case 3 may end as an explicit unverified
   limitation rather than a pass.
7. **Keep app-closed application as the supported fallback**, not replace it.
8. Approve the `app-paused` runtime mode as a third persisted, approval-bound
   `runtimeMode` value that cannot cross with the other two.

Implementation requires approval. Nothing in this design is started.

---

## 한국어 로드맵 현재 상태

**수용됨:** 그래프 바인딩 수정과 제한적인 유휴 상태 관찰 결과를 감독자가
수용했습니다. 메모리 전용 프로브 검사 15/15는 감독자가 직접 실행했습니다.
집중 라이브 결과 14/14는 여전히 코더가 보고한 증거입니다. **전체 라이브
관찰 행렬은 완료로 수용되지 않았고, 동시 편집 안전성은 검증되지 않은
상태로 남아 있습니다.**

**이번 작업:** 들어오는 변경 하나를 적용하기 위한 **제한적 편집/저장 일시
중지** 설계를 제안했습니다. 명시적인 "대기 중인 변경 적용" 명령 하나이며,
지속적인 동시 편집이나 일반 동기화 서비스가 아닙니다. 편집 버퍼와 한글 조합은
절대 강제 저장하거나 버리지 않고, 조합 중이면 안내 메시지와 함께 적용을
연기합니다. 저장 완료는 디스패치 플래그나 유휴 타이머가 아니라 실제 저장
원인(cause)의 종료로 확인합니다.

**아직 아님:** 이 설계는 **제안일 뿐이며 승인되지도 구현되지도 않았습니다.**
새로운 인앱 권한 다섯 군데(H1–H5)가 필요하고, 그중 요청 채널(H5)은 실제로
새로운 권한입니다. 네트워크·프로세스 제한, 렌더러 파일시스템 제한은 그대로
유지됩니다. 장벽은 협조적일 뿐 Finder·클라우드 에이전트·외부 편집기를
배제하지 못합니다.

**다음 단계:** 구현 여부와 새 적용 권한에 대한 감독자/사용자 결정.
