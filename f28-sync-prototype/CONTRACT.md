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
8. The persistence adapter acknowledges only after writing and syncing a
   temporary state file, atomically renaming it, and syncing its directory. An
   injected failure before acknowledgement throws instead of reporting success.

The adapter rejects absolute paths, traversal, and any symlink in an accessed
path. Tests create one fresh run beneath the approved `Logseq Test` root and do
not enumerate that shared root. The persistence injection tests establish the
ordering and retry behavior of this implementation under controlled in-process
exceptions. They do not establish storage-hardware or sudden-power-loss
durability.
