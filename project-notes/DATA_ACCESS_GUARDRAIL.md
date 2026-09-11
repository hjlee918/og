# Mandatory graph-data boundary

This tracked instruction applies to every Intel and Apple Silicon session in
this checkout. It is a data-access rule, not evidence that a particular host or
package has already enforced it.

## Sole permitted graph-data root

Graph data may be accessed only in canonically contained, explicitly test-owned
subfolders of:

`/Users/johnlee/Library/Mobile Documents/com~apple~CloudDocs/Logseq Test`

Before any graph access, resolve the allowed root and selected graph to their
canonical paths. Reject traversal, symlink escape, the root itself, and any path
outside it before reading directory entries, metadata, content or hashes.

Personal graphs, backups, exports and profiles are completely off-limits,
including read-only inspection, enumeration, metadata checks, hashing, copying,
restoration and indirect application access. Never launch installed Logseq or
use its profile. Never infer or search for personal graph locations.

Use a fresh synthetic graph in a uniquely named test-owned child unless the user
has explicitly identified an existing disposable test graph. Preserve other
test runs. Do not reset, overwrite, rename or delete the shared root. Assert the
exact LIVE graph identity before interaction, use an isolated TEST profile, and
fail closed if containment or profile ownership cannot be established.

On another host, verify that this exact approved root exists and canonicalizes
as expected before graph access. Do not guess a substitute path. Do not perform
simultaneous multi-host testing unless the user separately authorizes it.

