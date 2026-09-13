# F28 local synchronization prototype

This is a standalone CommonJS/Node experiment. OG does not import or package
it. See [CONTRACT.md](./CONTRACT.md) for its guarantees and limits.

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
