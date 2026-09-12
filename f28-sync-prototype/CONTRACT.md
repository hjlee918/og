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
