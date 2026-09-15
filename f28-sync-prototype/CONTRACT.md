# Experimental local synchronization contract

Status: limited local prototype. This directory is not imported by OG, bundled
with the application, or evidence of a production synchronization architecture.
The relay is a deterministic local simulator; it is neither encrypted nor
secure.

The prototype accepts caller-supplied synthetic graph, file, revision and
operation IDs. File IDs are independent of paths. Each accepted mutation adds
an immutable revision whose parent is explicit.

1. A mutation whose parent is no longer a head creates a retained conflict
   branch. It cannot silently replace a current head.
2. Every conflict records all participating revision IDs, so each version stays
   independently recoverable.
3. Repeating the same operation ID with byte-for-byte equivalent operation data
   returns the recorded result without adding a revision.
4. Reusing an operation ID with different data is rejected.
5. Delete creates a tombstone revision. Absence from a replica is not a delete.
6. Restore copies an earlier revision into a new revision with an explicit
   current parent. It does not remove later history.
7. Distinct file IDs that claim the same NFC-and-lowercase path create an
   explicit path-collision conflict. The prototype does not rename or merge
   either file.
8. The persistence adapter acknowledges only after writing and syncing an
   exclusively created temporary state file, atomically renaming it, verifying
   the installed inode, and syncing its directory. An injected failure before
   acknowledgement throws instead of reporting success.

## Pure reconciliation planner

The planner accepts an explicit JSON-serializable replica snapshot and an
ordered list of synthetic create, update, rename and delete events. Every event
has an explicit event ID, file ID and revision ID; non-create events also name
their parent revision. The planner derives a stable operation ID from the graph
and event IDs. It never reads a directory, applies a file change or infers an ID,
rename or deletion.

The output separates applicable actions, conflicts, exact duplicate events and
invalid events. Each proposed action records its operation, expected current
heads, expected parent revision content/path/deleted state, and reasons. The
planner applies actions only to an in-memory projected snapshot. A conflict or
invalid event does not advance that projection.

A core operation result of `committed` is insufficient by itself. A file with
multiple heads or a relevant open conflict remains blocked even if an operation
names one current head. New stale-parent and normalized-path conflicts are also
blocked. Update, rename and delete follow the same rule, so planning against one
branch cannot hide another branch or clear an unresolved conflict.

The plan records a stable fingerprint of the complete source snapshot. The pure
precondition check rejects applicability when a supplied destination snapshot
has any different fingerprint. It does not reserve or lock a destination; a
future applying component would have to check again at its own atomic commit
boundary. The planner clones its inputs and includes no clock, random value,
filesystem access, watcher, network, account or application integration.

## In-memory plan executor

The executor requires the original snapshot, original ordered event batch,
planner output and an explicit destination snapshot. It treats the supplied
plan as untrusted: it recomputes the canonical plan, checks the expected schema
and projected-state fingerprint, and requires the entire supplied plan to match
the recomputed plan. This covers altered actions, ordering, expectations,
reasons, identities and classifications.

The first executor rejects the whole batch when the plan contains any invalid
event or conflict. Exact duplicate events are allowed and produce no duplicate
operation. Immediately before execution it fingerprints a fresh clone of the
destination. A basis match may execute; an exact projected-state match is
reported as an already-applied batch; every other value is a stale-plan refusal
and is never silently rebased.

Eligible operations apply in order to a private clone. The clone is returned
only after every operation succeeds and its final fingerprint matches the plan.
Any error or controlled test failure returns a rejection with `state: null`, so
no partially applied state is exposed. Source state, destination state, events
and plan remain unchanged.

This synchronous behavior is only an in-memory atomic-return property. It is
not a durable transaction, filesystem atomicity guarantee, multi-process lock,
or solution to the persistence adapter's documented concurrent ancestor race.
The executor has no filesystem, watcher, network, account, profile or OG
integration.

## Synthetic filesystem application experiment

The Node coordinator recomputes the accepted plan and in-memory execution,
rejects any conflict or invalid event, materializes only a single head per
file, and sends canonical state plus complete target files through a bounded
fixed-order protocol. The C helper independently limits and validates protocol
fields, UTF-8, relative Markdown/Org paths, ownership components, fingerprints,
transaction IDs and selector names. SHA-256 binds retained bytes for comparison;
it is not authentication.

One helper holds an advisory lock on a stable inode throughout compare, stage,
publication, verification and acknowledgement. Only helpers following this
protocol participate. The lock does not block OG, editors, Finder, cloud agents
or hostile processes. Root, run and case directories are opened component by
component with `openat` and `O_NOFOLLOW`; later access is directory-relative and
recorded identities are rechecked. An outside process can still relocate an
already-open ancestor, so this remains a controlled single-writer experiment,
not an OS sandbox.

Each accepted batch writes a complete new generation exclusively, flushes each
file with `F_FULLFSYNC`, syncs directories, writes and verifies state and a
prepared manifest, then publishes one validated generation name through a
directory-relative `CURRENT` rename. The rename makes the selector transition
atomic for participating readers; it does not make preceding multi-file writes
atomic. Success is acknowledged only after selector and selected-generation
verification and final directory synchronization.

An exact prepared transaction may roll forward after restart. An exact
published plan/fingerprint pair is an idempotent retry. Incomplete unprepared or
inconsistent evidence is preserved and refused; no cleanup, guessing or silent
rebase occurs. Complete prior generations remain unchanged. Restore continues
to be a new planned revision and generation.

Before a retained `CURRENT.<transaction>.pending` entry is published, the
helper opens it relative to the anchored metadata directory with `O_NOFOLLOW`,
requires a regular file of exactly 65 bytes, and compares all 64 transaction
hex bytes plus the newline. Wrong content, type, symlink or transaction is
preserved and refused before `CURRENT` is replaced.

An already-published retry is acknowledged only after the selected generation
matches the request's exact transaction, plan, basis/projected fingerprints,
ordered operation IDs, canonical state bytes and complete materialized file
paths/content. Directory and lock identities and required synchronization are
then rechecked before success output.

Immediately before publication, the helper reopens and verifies the complete
selected basis generation: manifest structure, state hash/fingerprint and every
manifest-listed file. It also rechecks root/run/case/metadata/generations and
lock identities. These checks detect the controlled between-check changes in
the focused tests; they do not prevent an arbitrary writer from changing data
after a check or relocating an already-open ancestor.

The adapter caches the device/inode identities of the canonical approved root,
test run and store directory, then verifies all three at every persistence entry
point and around file operations. Reads use `O_NOFOLLOW` and match the opened
regular file to the expected state inode. Writes use a new unpredictable name
with `O_CREAT | O_EXCL | O_NOFOLLOW`, so an existing or substituted pending
entry is never opened or truncated. Before rename, both directory ownership and
the pending/destination identities are checked. After rename, the installed
state is reopened with `O_NOFOLLOW`, matched to the pending inode, and the owned
directory is synced before acknowledgement. Unexpected pending files are left
untouched as evidence.

These controls refuse substitutions visible at those checks and ensure that
leaf symlinks are not followed. Node does not expose the directory-relative
`openat`/`renameat` primitives needed to make the multi-step path operations
race-free against a hostile process that concurrently swaps ancestors between
checks. This standalone single-process simulator therefore fails closed when it
observes replacement but does not claim an OS sandbox or protection against an
active local filesystem attacker. Production use would require an anchored
directory-handle implementation or an equivalent platform-specific boundary.

Tests create one fresh run beneath the approved `Logseq Test` root and do not
enumerate that shared root. Persistence injection establishes the ordering and
retry behavior under controlled in-process exceptions. It does not establish
storage-hardware or sudden-power-loss durability.

## Read-only selected-generation comparison

The `read-selected` helper command opens only an explicitly named existing run
and case. It verifies both ownership records, opens the existing metadata,
generations and stable lock entries without creation, and holds a shared
cooperative lock. It verifies `CURRENT`, the selected manifest, canonical state
and every materialized file through anchored, non-following operations. Before
returning, it rereads `CURRENT`, reverifies the generation and rechecks the
opened directory and lock identities. Missing ownership, metadata, lock,
selector or generation state is a refusal; this command creates nothing.

Its `F28READ1` response has fixed ordered fields, a 128-file limit, per-path and
per-file bounds, and an 8 MiB combined state/path/content bound. The Node side
uses a five-second child-process limit and 20 MiB output cap, rejects malformed,
truncated or trailing protocol data, validates UTF-8 and JSON, and requires the
returned files to agree exactly with the returned state. This is an integrity
check across the helper/coordinator boundary, not authentication.

The pure comparison adapter accepts that verified envelope and an explicit
synthetic target snapshot. Stable file IDs supplied by the caller are the only
identity basis. It reports unchanged and unknown items, proposed events,
conflicts and invalid inputs. It records every explicitly mentioned non-empty
file ID before validating the entry, so an invalid or duplicated mention can
never be reinterpreted as absence. Absence remains unknown unless the target
declares itself complete, explicitly authorizes missing-file deletion, and has
no invalid or ambiguous comparison input. A valid supplied tombstone can
request deletion directly.

The corrected result schema is `f28-snapshot-comparison/2`. Proposed events are
diagnostic when any comparison conflict or invalid input
exists. Such a result has `eligibility.eligible: false`, code
`comparison-not-eligible`, and `plan: null`; callers receive no executable plan
for a partial batch. Only a wholly eligible comparison exposes the existing
planner plan and its source-snapshot precondition. Duplicate IDs, invalid paths,
NFC/NFD/case-normalized path collisions, multi-head identities, implicit
restore and a simultaneous rename plus content change are refused rather than
inferred or merged. Inputs are cloned and event identities are deterministic.

Neither layer applies a plan, publishes a generation, discovers a graph or
connects OG. The shared lock coordinates only participating helpers. The final
rechecks detect the controlled mutations in tests but do not close races against
an arbitrary writer after a check, prevent relocation of an already-open
ancestor, or provide a durable compare/apply transaction.

## Synthetic compare/preview/apply workflow

The standalone workflow joins the accepted reader, comparison schema v2,
planner, executor and native publisher for one explicitly named synthetic case.
`previewComparison` is the default entry point and performs only the verified
read and pure comparison. It records the exact selected generation, source
state, target, comparison and plan in one preview object. An unchanged eligible
target is marked `no-op`; a conflict, invalid input or null plan is marked
`rejected`.

Apply requires a separate `apply-exact-preview` request binding the preview ID,
run/case, selected generation, source snapshot fingerprint, exact target
fingerprint and exact plan fingerprint. Preview objects are registered and
checked in memory, including their complete canonical bytes. A copied, altered
or unissued object is not approval. These hashes detect accidental or test
tampering inside this process; they are not authentication, signatures or a
persistent approval store.

Before application, the workflow recomputes the comparison and plan, refuses
every ineligible or partial diagnostic result, reads the destination again and
runs the accepted executor precondition without rebasing. The publisher request
now carries `SELECTED`; while holding its exclusive lock, the helper requires
`CURRENT` to equal that exact preview generation, or the deterministic exact
transaction generation during retry. The selected generation is also recorded
in the request-derived manifest. Thus the earlier read is not treated as the
transaction boundary.

After acknowledged publication, the workflow reads the selected generation
again and requires its generation, state fingerprint, canonical state and
materialized files to match the previewed result. The deterministic transaction
identity permits prepared recovery and exact published retry without another
generation. A no-op rechecks the exact original generation/state and never calls
the publisher. Explicit completeness and deletion authority remain part of the
target covered by the preview and apply request.

This is one-process test orchestration, not a general synchronization service.
The in-memory preview cannot survive process restart. `flock` remains
cooperative, selector publication does not make generation writes multi-file
atomic, final checks do not control arbitrary writers, and injected failures do
not prove power-loss durability. There is no graph discovery, identity
enrollment, OG integration, watcher, account, network, encryption or import.

## Pure identity enrollment and change capture

The standalone identity module implements schemas `f28-file-identities/1`,
`f28-identity-replica/1`, `f28-identity-enrollment/1` and
`f28-capture-batch/1` in memory only. Explicit complete enrollment requires
caller-supplied graph, replica, file, metadata-revision and accepted-revision
IDs. It checks every supplied Markdown/Org path and content against the complete
accepted selected snapshot. A second simulated replica retains graph/file IDs
and receives separate replica-local pending state.

Accepted metadata must be a complete one-head mapping of the accepted snapshot.
Its graph ID, metadata revision, paths, NFC-and-lowercase keys, content hashes
and accepted revisions are checked on every capture. Replica state must name the
same graph, metadata revision and snapshot fingerprint. Content hashes are
consistency checks, not identity or authentication.

Controlled observations distinguish save completion, rename intent/completion,
stable-read assertions, external add/change/unlink, failed reads and unstable
reads. A save needs matching completion and stable-read observations. A rename
needs matching intent, successful completion, stable new-path bytes and an
explicit old-path-absent assertion. Intent alone changes nothing. External
unlink/add remain separate review items and never imply rename. A synthetic
`stable: true` value exercises this state machine; it does not establish that
a real filesystem read was stable.

Observation IDs are content-bound. Exact repetition is idempotent; changed ID
reuse and contradictory changes for one file reject the batch. Review decisions
must bind the exact current pending-item IDs and metadata revision. They may
explicitly ignore, create, delete or pair one known unlink with one add as a
rename. No identity is inferred from text, path or inode.

Any invalid or unresolved item sets `eligibility.eligible` to false and exposes
no target or comparison plan. Valid observations are retained in replica-local
pending evidence when the all-or-nothing batch is rejected. A fully eligible
change produces separate proposed metadata and a complete synthetic target,
then calls only the existing pure comparison function. The accepted metadata is
unchanged. Source observations for a proposed graph change remain pending until
a later caller reinitializes from an actually accepted metadata/snapshot pair;
target preparation is not application or acknowledgement. A pure no-op or
ignore-only decision has no graph change to acknowledge.

Captured events retain their causal IDs for diagnosis, but they are not the
executable identity contract. The existing comparison result is authoritative:
the module executes that exact comparison plan in memory and derives proposed
metadata from its projected revision state. Consequently every proposed
`acceptedRevision` is the revision the exposed plan will create. If comparison
finds unchanged bytes and exposes no action, proposed metadata retains the
accepted revision and metadata revision; the unused causal revision ID is not
adopted.

This module creates no sidecar, reads no filesystem, calls no preview reader,
native helper or publisher, and is not imported by OG. Real watcher stability,
metadata persistence, stable-working-tree application, sidecar placement and
cross-device synchronization remain unimplemented.

## Stable synthetic working-folder experiment

The standalone `stable-working-tree.js` coordinator validates the exact issued
preview and authoritative comparison plan, executes it in memory, and derives
projected metadata from that exact revision state. A preflight checks one
stable synthetic working directory against the preview basis before the
existing publisher selects the immutable projected generation. The working
helper then binds its immutable journal to the preview fingerprint, basis and
target generations, plan, ordered operation IDs, before/after paths and content
hashes, and complete base/projected metadata bytes.

The x86_64 C working helper opens only an existing owned run and case through
the approved anchored root. It uses the existing stable cooperative lock inode,
independently validates the parameterized working and metadata directory
components, rejects traversal and links at anchored opens, and requires
`F_FULLFSYNC`/directory synchronization rather than silently downgrading.
Initialization verifies the selected generation's state and materialized files
before creating the synthetic stable folder.

Before changing live files, it writes and verifies retained before-images,
intended new bytes and the immutable transaction journal. Create refuses an
occupied destination; update requires exact prior bytes; rename requires exact
source bytes and an unoccupied destination; delete moves the exact source to
transaction recovery storage. Each action is rechecked immediately before its
directory-relative mutation, verified afterward and followed by a synchronized
progress marker. A multi-file interruption can therefore expose a mixed working
state. No whole-batch filesystem atomicity is claimed.

Restart accepts only exact before or exact after state for every action. A third
state stops without overwrite or rollback and preserves journal, staging,
recovery and generations. Metadata is accepted only after all file results
verify, using the exact comparison plan's revisions. Acknowledgement follows
metadata, journal and selected-generation verification and synchronization.
Exact retry creates no duplicate action. Controlled watcher events are echoes
only when operation, file identity, old/new paths, presence and new-content hash
all match a reconstructible cause record; path or time alone never suppresses
an event.

This is preconditioned per-file application with recovery, not an atomic
compare-and-swap against arbitrary external writers. `flock` coordinates only
participating helpers. Repeated checks do not remove the race between a check
and a write, prevent an external editor, provide whole-graph atomicity or prove
power-loss durability. The selected generation may advance before a later
working-file refusal; the retained journal/evidence requires recovery or a new
reviewed preview. Real metadata placement, OG hooks, Chokidar, real graphs,
accounts, network, encryption, mobile and cross-device sync remain excluded.

## Default-off OG event bridge

The removable `frontend.fs.og-sync-bridge` namespace is compiled with
`ENABLE-OG-SYNC-BRIDGE` false unless a future separately approved build changes
it. No package in this checkpoint changes that define. Tests inject a dynamic
runtime containing in-memory state, a serialized-string operational store, a
complete-state filesystem reader and a reconciliation callback. Production
with the flag off constructs no bridge payload or transaction state and adds no
promise, write, wait or watcher suppression.

Save pending is registered immediately before the existing `writeFile` IPC.
Completion follows the existing successful side effects; failure is emitted
from the existing catch path. Rename intent binds the exact repo and old/new
paths, while completion follows `fs/rename!` and the existing success callback;
the existing catch remains the failure settlement. Opaque cause tokens, rather
than current global graph state, bind later results. Adapter exceptions block
experimental coordination without changing a successful OG operation or
hiding its original error. Pending local mutations include both saves and
renames: an unfinished rename blocks an incoming cause touching either its
source or destination in that graph, but does not block unrelated paths or
graphs.

Raw watcher events have no operation ID. The injected complete-state reader
compares full path/presence/content evidence with retained causes. A unique
completed local cause is classified separately from incoming work. Zero or
ambiguous matches and different content remain ordinary observations. A unique
incoming match calls the injected asynchronous reconciliation boundary. Its
cause remains in flight, so duplicate observations do not start duplicate work.
Only successful settlement followed by successful transaction-bound progress
storage permits a later equal event to be an echo. Either rejection leaves
retryable evidence and is handled without an unhandled rejection. This is not a
crash-proof exactly-once guarantee. Synchronous-only hook ports fail closed if
they return a thenable; declared asynchronous ports are awaited.

The versioned synthetic ACTIVE envelope contains the exact graph, replica,
snapshot, preview, target, authoritative plan, projected snapshot, proposed
identity bytes, generation, ordered operation, working-journal, graph-binding
and cause inputs. Simulated restart verifies its transaction digest, recomputes
the authoritative plan and revalidates the binding. Serialized phase and
progress fields are not proof: files-applied, reconciliation and identity
acceptance are restored only from exact transaction/cause/operation-bound
receipts validated by injected synthetic authoritative ledgers. Unknown or
malformed entries fail recovery; unverified but well-formed claims are
downgraded to pending. Failed recovery retains the envelope/evidence and latches
the runtime blocked. An incompatible batch is refused while ACTIVE or failed
recovery remains. Identity acceptance requires complete injected
file/identity/checkpoint/binding evidence; a snapshot checkpoint alone cannot
clear ACTIVE.

A separate test-only adapter (`frontend.fs.og-sync-e2e-adapter`, under
src/test, imported by no production namespace) backs the same port contract
with the actual standalone prototype modules: the `:revalidate-plan!` port
recomputes the plan through the real snapshot-comparison module over the
retained source/target pair instead of echoing the caller's plan, and the
`:validate-acceptance!` port re-derives the projection and validates the
retained sidecar bytes with the real identity-capture module. The `:adapter!`
recorder follows the port's actual delivery contract — exactly one argument,
the event map, with the event kind as the port phase — and keeps any
non-event argument as a visible `{:event :invalid-event-record}` marker, so
nil/undefined records cannot pass unnoticed. The `:complete-state!` port
derives rename evidence from the simulated working folder only: a rename
complete map requires old-path absence plus byte-identical new-path content
matched against a retained rename cause; missing, contradictory or ambiguous
old/new-path evidence yields no rename match (zero/multiple candidates stay
`:ordinary`), and a rename is never inferred from content alone. Working
files, the checkpoint, the sidecar, the ACTIVE store and the evidence ledgers
remain in-memory atoms, and review decisions plus watcher observations are
synthetic inputs, so this adapter verifies component agreement only — no real
storage durability or usable synchronization is implied.

Every ACTIVE publication is serialized through one process-local coordination
boundary. Each runtime owns a first-in/first-out chain of coordination turns
reserved in call order: `start-active!`, reconciliation publication,
`recover-active!`, `mark-files-applied!`, `accept-identity!` and `finish-active!`
each claim their turn before any asynchronous port is invoked, so overlapping
starts are refused deterministically in call order, recovery cannot race a
start, and a rejected turn never stalls later turns. A turn that reenters the
bridge from an injected callback reserves the next turn rather than deadlocking,
provided the callback returns its own value without awaiting the nested turn's
result: awaiting a queued turn from inside a running turn would wait on a turn
that cannot run until the callback's own turn settles. That awaiting shape is
forbidden by the port contract; the FIFO boundary neither detects nor refuses
it, and no general deadlock-freedom claim is made for it. Inside a turn each
operation revalidates that the exact owning transaction still holds the active
slot before its persisted write and in-memory installation, and every turn
rechecks the runtime's blocked latch at section start and after every awaited
port: a turn reserved while the runtime was unblocked still refuses to publish
once a prior turn, a failed recovery, or a callback reentering from an awaited
port latched the runtime blocked. Reconciliation reserves that owning
transaction before its asynchronous reconciliation call and merges one
transaction-bound entry into the fresh ACTIVE record when its progress receipt
settles, so out-of-order completions preserve every progress entry and never
regress a later phase; files-applied publication is idempotent and
phase-preserving; a stale finish cannot clear a newer lifecycle. This boundary
coordinates only this process's in-memory runtime state and synthetic
persistence ports. It is neither a cross-process lock nor crash durability, and
no such claim is made.

A persistence failure does not prove that nothing was persisted. Only two save
outcomes are clean refusals: the write port was never invoked (missing port), or
the port explicitly declares `:proven-no-write`. Any other save rejection or
throw leaves the durable outcome unknown, so `start-active!` reserves the exact
attempted envelope — transaction ID, serialized bytes and the failure — as
recovery-required evidence and refuses every incompatible start with
`:uncertain-active`. Only the exact same transaction may retry through the
reservation, and a successful republication of that transaction or validated
recovery clears it; there is no permanent dead end. An uncertain clear is
treated the same way: a clear-active rejection without proven-no-write
evidence reserves the exact accepted transaction — transaction ID, serialized
envelope and the failure — as an outstanding `:uncertain-clear` reservation and
returns `:clear-active-uncertain`. While that reservation stands no clear is
repeated and no other transaction is admitted: a repeat `finish-active!` and
every start are refused, and reconciliation publication cannot resurrect the
record the outstanding clear may already have removed. Only validated recovery
resolves it — a verified-empty store confirms the clear, while a validated
record that survives proves the clear failed and installs normally — and a
proven no-write clear refusal (missing port or explicit `:proven-no-write`)
remains separately retryable with no reservation at all.
Progress-save rejections in `mark-files-applied!`, `accept-identity!` and
reconciliation publication need no reservation of their own: the installed
owning ACTIVE record already refuses incompatible work and an exact retry
converges, so their typed failure results (`:progress-recording-failed`,
`:acceptance-recording-failed`, `:reconciliation-failed`,
`:clear-active-failed`) preserve the exact installed record and receipt
evidence for retry. Failed recovery retains the envelope/evidence and latches
the runtime blocked before any queued turn can perform operational work.

A missing ACTIVE record is not automatically proof of completed work.
`recover-active!` rechecks the blocked latch after its awaited load before
changing any ownership, and settles a verified-empty store only where the
retained evidence supports it: an idle runtime reports `:none`; verified
absence resolves an outstanding uncertain-save reservation
(`:resolved :uncertain-save`); and verified absence confirms an accepted
transaction's outstanding uncertain clear (`:resolved :uncertain-clear`).
Anything else installed in memory is preserved rather than forgotten: an
unfinished transaction whose persisted record disappeared with no uncertain
clear explaining the absence fails with `:missing-active-record`, retaining
the in-memory owner and typed evidence and latching the runtime blocked, and a
durable record that belongs to a different transaction than an outstanding
uncertain clear fails with `:unexpected-active-record`, preserving the stored
record, the in-memory owner and the reservation rather than installing over
them. Recovery evidence records the failure's typed code alongside its
serialized and envelope material.

The default-off OG event bridge described above implements only tested
infrastructure. It creates no sidecar, chooses no copied-graph policy, enrolls
no graph, invokes no native helper, persists no real metadata, launches no
application and performs no network synchronization.

## Test-only persistent identity and recovery records

The standalone `src/persistent-identity.js` adapter and its
`native/identity_store_helper.c` boundary persist portable graph identity and
device-local recovery records across two explicitly owned locations. They are a
test-only experiment: no OG namespace imports them, no package enables them, and
they synchronize nothing between two devices or two processes. The design,
schemas, orderings and recovery table are in
[PERSISTENT_IDENTITY_DESIGN.md](./PERSISTENT_IDENTITY_DESIGN.md).

The second anchored root was approved by the user for testing on 2026-09-15,
after this implementation had already been built and committed. The preceding
batch had been instructed to stop and explain rather than implement it, and did
not stop; the later approval is forward-looking and does not retroactively make
that a compliant sequence. Any further root, authority expansion or weakened
guard requires a separate user decision.

The existing verified helpers could not perform this stage. Both are anchored to
one compile-time root and address every directory as a single component inside
one `<run>/<case>` beneath it, so neither can reach a profile under
`~/Library/Application Support`, and Node exposes no `openat`/`renameat`. The
required additional boundary is therefore a **second compile-time anchored root
of equal strictness in a new helper**. `identity_store_helper.c` compiles both
the approved `Logseq Test` root and the new `Logseq OG F28 IdentityExp` profile
root, requires the caller to send each byte-for-byte, and can express no other
location. `filesystem_helper.c` and `working_tree_helper.c` are unchanged and no
guard in them is relaxed.

Identity itself is not reimplemented: enrollment, replica initialization and
metadata validation are the existing `identity-capture.js` functions, and the
snapshot they validate against is rebuilt from the bytes actually read out of the
graph through anchored, non-following opens.

Enrollment is explicit only. `openGraph` reads, validates and classifies, and
never writes; an opened graph is never enrolled as a side effect. Only an
explicit `complete` list of caller-supplied file IDs, paths, contents and
accepted revisions creates a sidecar, and each supplied content must equal the
bytes on disk. Enrollment writes only inside the hidden `logseq/.og-sync`
directory that OG's reader and watcher already skip; a hash over every note file
of the graph is identical before and after.

The portable sidecar `logseq/.og-sync/identity-v1.json` (`f28-graph-identity/1`)
carries the graph ID, metadata revision, accepted transaction, accepted snapshot
fingerprint, selected generation and the complete identity map. A validator
enforces its exact key set and refuses any replica, device, binding, cursor,
lock, lease, token, secret, credential or absolute-path material at any depth.
The device record (`f28-device-record/1`) is the only place a replica ID, device
ID and the exact transaction/graph/replica binding — run, graph directory, device
and inode — are stored, and it never travels with the graph. It also binds the
profile it lives in by run, profile directory, device and inode, so a device
record copied or moved into another owned profile is refused rather than accepted.

Each owned run/profile pair carries one cooperative lock at `<profileDir>/LOCK`,
opened relative to the anchored profile directory with `O_NOFOLLOW`, required to
be an ordinary file, taken shared for reads and exclusively for mutations, and
held for the whole command. It serializes participating helper invocations only:
OG, Finder, cloud agents and external editors do not honour it, it is not a
durability mechanism, and end-to-end serialization of two concurrent adapter
processes has not been tested. Every command that opens the graph or profile
directory retains its owned parent handle and entry name beside the recorded
device/inode, and before reporting success re-opens that parent-relative entry
with `O_NOFOLLOW` and compares identities with the retained handle. An open
descriptor keeps referencing its original directory after its pathname is
renamed or replaced, so the same-descriptor check this replaces was vacuous.
The entry check detects, at the moment of the check, an entry renamed away or
replaced by a different directory or a symlink; it prevents nothing, and a
relocation after the check — or of any ancestor above the re-opened entry —
still passes unnoticed.

The unchanged-note claim is a hash over Markdown/Org notes only, by exact
relative path and exact bytes. Any other regular file in the graph tree is
counted and reported separately and never mixed into that hash, so an
operating-system file written beside the notes neither changes the hash nor is
silently absorbed.

Cross-directory atomicity does not exist here and is not claimed. Each record
write states the exact state it requires its destination to be in — absent, an
exact content hash, or `any` for a fixture write — and the helper rechecks that
expectation immediately before the rename, under the lock, rather than trusting
the caller's earlier read; a publication derived from a stale read refuses and
preserves what is actually there. Each write refuses a non-regular destination,
stages under a fresh per-attempt unpredictable `.pending` name with
`O_CREAT|O_EXCL|O_NOFOLLOW`, `F_FULLFSYNC`s, renames within that one directory,
syncs it, then reopens the installed file with `O_NOFOLLOW`, matches the staged
inode and compares exact bytes. One record write
is atomic for a reader of that one directory; a two-tree batch is not. A pending
file retained from an interrupted attempt is never reopened, truncated or reused:
it stays as evidence while the retry stages under a new name.

Publication writes the intent first in both orderings, then the two records in
the recorded order, then clears the intent as a separately failing step. The
intent records base and target hashes and the exact staged bytes, and carries no
phase, step or status field at all. Recovery therefore hashes what is actually on
disk in both trees and classifies `prepared`, `graph-applied`, `device-applied`,
`applied` or `mismatch`; a third state refuses and preserves everything. An
observed hash is matched against target before base, so a record already at its
intended state is never rewritten. With no intent present, absent/absent is
`unenrolled`, and a sidecar without a device record, a device record without a
sidecar, disagreeing records, a stale metadata revision and graph bytes that no
longer match the accepted sidecar are each a typed refusal that changes nothing.
A missing file is never by itself proof that work completed.

A failure after staging leaves the durable outcome unknown. Only a failure before
staging is a proven no-write refusal; every other write failure returns
`uncertain-write`, and a clear failure after the unlink returns `uncertain-clear`,
each reserving the exact transaction through the retained intent and a retained
evidence record. An enrollment, update or adoption re-issued with identical
inputs recomputes the identical transaction ID and is routed through recovery
rather than writing again, so an exact retry creates no second identity; differing
inputs are refused as `incompatible-transaction` while the intent stands.

A copy is never resolved automatically. Identical bytes, identical paths, an
identical sidecar and the observable inodes do not decide it: a graph whose
device record binds a different location, or for which this device holds no
record, is refused as `copied-graph-choice-required` or `missing-device-record`
until the caller passes one explicit choice. `same-lineage-new-replica` keeps the
graph ID, requires an explicit new replica and device ID, writes only a new device
record and leaves both sidecars byte-identical. `new-graph-lineage` requires a new
graph ID and entirely new file IDs — a reused graph or file identity is refused —
so two independent graphs can never be merged later. Unparseable record bytes are
retained and reported as evidence rather than treated as a read error, and every
writing entry point refuses while any record is malformed.

Unreleased limits are unchanged and inherited. Anchored component-by-component
opens with `O_NOFOLLOW` refuse traversal, symlinked notes, symlinked ancestors, a
symlinked sidecar container and a symlinked lock, and the destination
precondition refuses the substitutions visible at those checks, and the entry
re-verification detects, when it runs, a graph or profile entry renamed away or
replaced; none of this makes the sequence race-free against a process that
relocates an already-open ancestor between checks, which is neither prevented
nor detected. This is not an OS sandbox, and no
cross-process or cloud-storage guarantee is claimed. Injected failures establish
ordering and recovery classification only — they do not establish
storage-hardware or power-loss durability, and no real power-loss test was run. Nothing here runs a watcher,
launches an application, contacts a network, account or service, imports anything,
or is enabled in any package. Real OG enrollment, a sidecar in a real graph and
any enabled build remain separate future approvals.

## Live capture contract (2026-09-15 identity-capture batch)

The preceding paragraphs describe the store, the adapter contract and the
observation seams in isolation. The identity-capture batch connected them
under one approved contract, recorded in
`f28-identity-capture/LIVE_CAPTURE_DESIGN.md` and verified live in
`f28-sync-prototype/RESULTS.md` (section "Live OG save/rename capture into
persistent identity records"). Its terms, which extend this contract without
weakening any of it:

- **The application gains nothing.** A separately packaged experimental build
  carries exactly the observation-only runtime; an external test-owned
  coordinator — a plain operator-started Node process, outside the app —
  reads the sanitized cause stream through the existing read-only page API
  and invokes the anchored helper for every graph-byte read and record
  write. No new privileged IPC, process-launch exception, access root or
  renderer filesystem access exists anywhere in the flow, and the in-app
  process-launch refusal stays on.
- **OG remains the sole note writer.** The coordinator never issues a note
  write against the live graph; its only graph-tree writes are the
  helper-owned `logseq/.og-sync` records. A completed OG edit is never
  reapplied as an incoming write.
- **Completion is cause-bound, not time-bound.** One logical save is the
  group of causes sharing the exact graph-id + path + content-hash, complete
  only when every cause in the group completed; a pending or failed cause,
  intent or queue flush is never completion evidence.
- **Acceptance requires a stable read-back.** The exact note is read twice
  through the anchored helper and must be byte-identical with a SHA-256
  equal to the cause's content hash (a rename additionally requires the old
  path absent twice and the bytes unchanged). An unstable, mismatched or
  superseded read leaves the operation pending — recorded, never falsely
  accepted — and the store's refusal to read a disk-ahead graph as accepted
  is itself the pending state.
- **OG's results are never affected.** A capture or record-persistence
  failure stops capture only: the saved note stays saved, its bytes are
  re-read and asserted unchanged, and no experimental path reports an OG save
  as failed, erases a note or alters an OG error. Recovery of the reserved
  transaction — never a re-derivation over the moved sidecar — is the only
  continuation after an uncertain second-record write.

Real OG enrollment of one fresh synthetic graph happened under this batch
and this contract, on one host, through the external coordinator. It is
still not synchronization: no change moves between devices or processes, no
incoming change is applied, no personal graph is enrolled, and nothing is
enabled in any normal or existing package; transport and incoming
application remain separate future approvals.

## Incoming change application contract (2026-09-15)

The first slice in which the external coordinator writes note bytes. Its design
is `INCOMING_CHANGE_DESIGN.md` and its verified results are in `RESULTS.md`,
section "Incoming change application (2026-09-15)". Its terms extend this
contract without weakening any of it.

- **The application still gains nothing.** The packaged build is the accepted
  observation-only IdentityCapture package, reused unmodified and not rebuilt:
  no persistence port, no synchronization port, no helper execution, no new
  IPC, no process-launch exception, no network permission, no renderer
  filesystem access beyond OG's own. `ENABLE-OG-SYNC-BRIDGE` remains false and
  no OG source changed.
- **OG is still the only note writer while it is running.** The coordinator
  writes notes only while the owned application is proven to have exited, only
  through the anchored helper, and only with an exact destination precondition.
- **No unconditional note write is reachable from the incoming path.**
  `putNoteExpecting` requires `absent` or a 64-hex content hash, has no default
  and rejects `'any'`. `putNoteFixture` keeps `expect: 'any'` and is reachable
  only from explicitly identified fixture and seed call sites.
- **Exact base, never rebased.** A proposal must name the accepted
  `metadataRevision`, `acceptedSnapshotFingerprint`, `acceptedTransactionId` and
  `graphId`. Any other base refuses `unknown-base`. The plan is recomputed with
  `compareSnapshots` and a proposal whose plan is not reproduced refuses
  `plan-mismatch`; the proposal never names revisions on its own authority.
- **Newer local edits refuse by content, not by time.** Every affected file is
  read twice through the anchored helper and compared with the accepted record.
  A disk-ahead graph refuses `local-ahead-of-accepted`, an absent accepted note
  refuses `missing-base`, an occupied create destination refuses
  `destination-occupied`. There is no merge, no last-writer-wins and no
  time-window rule.
- **Preview and explicit approval.** `planIncoming` writes nothing anywhere.
  `applyIncoming` requires the exact `previewFingerprint` to be passed back and
  recomputes the preview from scratch, refusing `preview-stale` on any
  difference. There is no default, timeout or standing approval.
- **Two kinds of refusal, never conflated.** A preflight refusal carries
  `mutated: false` and is raised before the first note write. An interruption
  after a note write carries `mutated: true` and the exact list of files already
  at target. "Nothing changed" is said only of the first kind.
- **Paths and parents.** An incoming target must be a direct child `.md` of
  `pages/` or `journals/`, and its parent must be **proven to exist** by an
  accepted file in that parent reading back through the anchored walk. Syntax
  alone is not enough, because `put-note` creates missing directories. An
  unproven parent refuses `unproven-parent-directory` before the helper is
  invoked, so incoming application creates no directory.
- **Bytes.** Notes must be valid UTF-8 that round-trips through the string APIs;
  bytes that do not are refused `non-roundtrip-bytes`, never replaced. Per note
  256 KiB, per serialized journal 2 MiB, both enforced before the first note
  write.
- **One bounded journal at one compile-time name.** `write-journal` and
  `read-journal` reach only `<profileDir>/incoming-journal.json`; the caller
  expresses no path. The immutable `approved` half is guarded by `approvedHash`;
  `progress` is the only mutable part and is a claim, never proof. The journal
  slot is the transaction lock: creation requires `absent` or the exact hash of
  a `closed` journal, so an unfinished transaction refuses a fresh proposal with
  `transaction-outstanding`, and a resumed coordinator discovers it by reading
  one fixed path with no listing. A closed journal is retained and superseded,
  never deleted; there is no `clear-journal` command.
- **Recovery earns the right to write.** Schema, exact key sets, bounds, hex and
  hash well-formedness, `approvedHash`, graph and profile bindings including
  device and inode, graph lineage, accepted base, a recomputed plan and a
  complete unique byte-ordered `applyOrder` must all hold. These establish
  **consistency, not authenticity**: a forger with write access to the owned
  profile directory can produce a self-consistent journal and nothing here
  detects it.
- **Whole-transaction preflight, roll-forward only.** Every file is classified
  from disk before any is written. A single `third-state` anywhere stops
  recovery before any further note mutation, including files earlier in the
  order that were still pending. Each remaining destination is rechecked
  immediately before its own write through the helper's precondition — still a
  recheck-then-rename, not a compare-and-swap. There is no automatic rollback;
  before-images are evidence for a later, separately approved restoration.
- **Disk decides progress.** `progress.applied` is cross-checked against the
  disk classification and a disagreement is reported, not treated as an error:
  an interruption between a note write and its progress update is expected.
- **The app-closed gate is verified before every write.** A dead retained PID
  tree plus zero processes carrying the exact packaged executable name, with
  unreadable process state treated as uncertain and refused, and re-evaluated
  per write so a stale verdict cannot authorize a later one. It excludes one
  application and nothing else — not Finder, cloud agents, external editors, a
  second coordinator, or the same app launched again after the check passes.

This is not cross-device synchronization. The second replica is a synthetic
in-memory state on the same host; there is no transport, no peer and no network.
Incoming rename and delete, application while OG runs, real transport, personal
data enrollment and daily use remain separate future approvals.
