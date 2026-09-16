# F28 local synchronization prototype

This is a standalone CommonJS/Node experiment. OG does not import or package
it. See [CONTRACT.md](./CONTRACT.md) for its guarantees and limits.

[INCOMING_CHANGE_DESIGN.md](./INCOMING_CHANGE_DESIGN.md) designs how an incoming
change is applied without silently overwriting a newer local edit. Its first
slice is implemented in `src/incoming-application.js` and verified in
[RESULTS.md](./RESULTS.md); creates and updates only, one host, synthetic data,
with the test application closed during application.

[APP_RUNNING_INCOMING_DESIGN.md](./APP_RUNNING_INCOMING_DESIGN.md) designs an
**idle-app observation experiment** — writing one incoming file while the
isolated test app is open but untouched, and measuring how OG's ordinary
external-change path behaves. Its option A was implemented and run; the
supervisor accepted the graph-binding correction and the **limited** observation
findings, and independently ran the memory-only probe checks. The complete live
observation matrix is **not** accepted as finished, and concurrent-edit safety
remains unverified and unclaimed.

[EDITING_PAUSE_DESIGN.md](./EDITING_PAUSE_DESIGN.md) is **closed as deferred**.
It designed that document's option B — a short, explicit "Apply pending changes"
pause. The supervisor accepted its recommendation to defer the pause and retain
the accepted app-closed path. It is **not safety-complete** and must not be
cited as such: its §0.2 records six unresolved findings — no helper
expiry/termination contract, a §5.2/§5.4 contradiction, incompatible mandatory
live cases, incomplete ledger ownership, editor transactions the gates do not
cover, and a durable marker with no approved schema, target, lifecycle or
restart-ordering contract. They are recorded, not redesigned, and §0.2 also
records the corrections made to two of the findings' own source claims. Nothing in it is approved or implemented, and
nothing in it is to be implemented.

The accepted app-closed application path
([INCOMING_CHANGE_DESIGN.md](./INCOMING_CHANGE_DESIGN.md)) remains the
foundation for the next step.

Korean summaries: this experiment's summary is
[F28_ROADMAP_SUMMARY_KO.md](../F28_ROADMAP_SUMMARY_KO.md). The **authoritative**
comprehensive roadmap is the user's own
`project-notes/PROJECT_ROADMAP_KO.md`, outside this repository; where the two
differ, that one governs.

Run the incoming-application suite with the identity helper, in fresh owned
children of one fresh run:

```sh
F28_IDENTITY_HELPER=/tmp/f28-identity-store-helper-x86_64 \
F28_RUN_NAME=<fresh-owned-run> F28_OWNER_TOKEN=<64-hex-token> \
F28_CASE_SUFFIX=<new-case-suffix> \
node --test f28-sync-prototype/tests/incoming-application.test.js
```

Run each filesystem-backed suite in its **own** `node --test` invocation with its
own `F28_CASE_SUFFIX`. Several suites in one invocation share a case suffix and
collide on case directory names.

Run the pure and filesystem-focused tests from the checkout root:

```sh
node --test f28-sync-prototype/tests/core.test.js \
  f28-sync-prototype/tests/planner.test.js \
  f28-sync-prototype/tests/executor.test.js
node --test f28-sync-prototype/tests/persistence.test.js
```

Build the standalone Intel helper outside the repository, then supply one
explicit fresh run name and owner token to the integration test:

```sh
f28-sync-prototype/build-helper.sh /tmp/f28-filesystem-helper-x86_64
F28_HELPER=/tmp/f28-filesystem-helper-x86_64 \
F28_RUN_NAME=<fresh-owned-run> F28_OWNER_TOKEN=<64-hex-token> \
F28_CASE_SUFFIX=<new-case-suffix> \
node --test f28-sync-prototype/tests/filesystem-application.test.js
```

Set `F28_SANITIZE=1` while building to enable AddressSanitizer and
UndefinedBehaviorSanitizer. Never reuse a failed case suffix; retained case
directories are recovery evidence. The helper binary and generated run are not
Git artifacts.

The first command runs only the in-memory transition, planning and execution
tests; the planner and executor import no persistence or application code. The
second runs the earlier filesystem persistence tests and therefore requires the
approved test root.

The filesystem tests create exactly one fresh test-owned directory under the
mandatory `Logseq Test` root. It does not list that root, remove older runs, or
touch an existing graph. Generated state is retained outside Git and must never
be committed.

Build the separate stable-working-folder helper with the same installed Intel
toolchain, then run its focused test in new case subdirectories of one fresh
owned run:

```sh
f28-sync-prototype/build-working-helper.sh /tmp/f28-working-tree-helper-x86_64
F28_HELPER=/tmp/f28-filesystem-helper-x86_64 \
F28_WORKING_HELPER=/tmp/f28-working-tree-helper-x86_64 \
F28_RUN_NAME=<fresh-owned-run> F28_OWNER_TOKEN=<64-hex-token> \
F28_CASE_SUFFIX=<new-case-suffix> \
node --test f28-sync-prototype/tests/stable-working-tree.test.js
```

The test creates only explicit case names below that run; it never discovers or
lists the shared root. Set `F28_SANITIZE=1` when building the working helper for
its AddressSanitizer/UndefinedBehaviorSanitizer pass.

Build the separate two-root identity/recovery store helper with the same
installed Intel toolchain, then run its focused test in fresh owned children of
one fresh run:

```sh
f28-sync-prototype/build-identity-helper.sh /tmp/f28-identity-store-helper-x86_64
F28_IDENTITY_HELPER=/tmp/f28-identity-store-helper-x86_64 \
F28_RUN_NAME=<fresh-owned-run> F28_OWNER_TOKEN=<64-hex-token> \
F28_CASE_SUFFIX=<new-case-suffix> \
node --test f28-sync-prototype/tests/persistent-identity.test.js
```

This helper is the only one anchored to two compile-time roots: the approved
`Logseq Test` root and the new `Logseq OG F28 IdentityExp` profile root. It
creates the profile root if it is absent and touches no other profile. See
[PERSISTENT_IDENTITY_DESIGN.md](./PERSISTENT_IDENTITY_DESIGN.md) for the schemas,
write ordering and recovery table, and `CONTRACT.md` for its guarantees and
limits. Set `F28_SANITIZE=1` when building it for the
AddressSanitizer/UndefinedBehaviorSanitizer pass; that build is several times
slower, so give it a longer wall-clock budget.

The test creates only explicit graph and profile directory names below that run
and never lists the shared root. Generated graphs, sidecars, device records,
retained evidence and the experimental profile are not Git artifacts.
