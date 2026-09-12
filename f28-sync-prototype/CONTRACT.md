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
