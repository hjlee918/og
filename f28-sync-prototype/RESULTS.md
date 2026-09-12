# Limited local synchronization prototype results

Date: 2026-09-11

## Scope and outcome

The standalone prototype implements the contract in
[`CONTRACT.md`](./CONTRACT.md) without importing code into OG or changing an app
package. The pure core stores immutable whole-file revisions under synthetic
file IDs that do not depend on paths. It records explicit branches for stale
edits, edit/delete and rename/rename conflicts, preserves tombstones, makes
exact operation retries idempotent, rejects changed operation-ID reuse, restores
old content as a new revision, and reports NFC/NFD-normalized path collisions
without renaming or merging either file.

The filesystem adapter persists JSON state for two synthetic replicas and a
local relay. It validates the approved root and fresh run canonically, rejects
traversal and symlink escape, syncs a temporary file, atomically renames it and
syncs its directory before acknowledgement. Generated state remains in its
fresh test-owned run outside Git; no graph content or runtime state is committed.

## Tests

- Pure state transitions: 7/7 passed.
- Filesystem persistence and containment: 4/4 passed.
- Total focused tests: 11/11 passed.
- Syntax checks: both prototype source files passed `node --check`.

An initial sandboxed filesystem invocation was refused before it could create a
run. The persistence-only suite then passed 4/4, and the final combined suite
passed 11/11 after bidirectional rename/delete propagation was added. Each
successful filesystem invocation created one distinct fresh test-owned child;
both runs remain preserved, and the shared root was never enumerated.

The tests cover bidirectional create/update/rename/delete propagation, offline
divergent edits, edit/delete and rename/rename conflicts, stable IDs, exact
Korean/English content, NFC/NFD collisions across two file IDs, exact retry,
changed operation-ID reuse, restart, restore, traversal and symlink refusal.
Controlled failures occur after temporary-file sync but before rename, and
after durable rename but before acknowledgement. The first remains uncommitted;
the second is found after restart and its retry adds no duplicate revision.

## Limits and next proposal

The failure injection proves this implementation's control-flow ordering under
in-process exceptions. It does not prove sudden-power-loss or hardware
durability. The relay is a local simulator, not encrypted or secure. There is no
network, account, attachment streaming, block identity, parser-aware merge,
mobile adapter, OG watcher integration, existing-graph enrollment or UI. The
prototype does not assign IDs to existing notes or rewrite graph formats.

After supervisor and user review, the smallest next batch would build a local
synthetic reconciliation adapter: accept an explicit list of file events,
translate them into this operation contract, and emit a reviewable write plan
without applying it or integrating it into OG. This batch does not begin that
work and does not establish MVP-A or MVP-B completion.
