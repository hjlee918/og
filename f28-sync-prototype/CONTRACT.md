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
