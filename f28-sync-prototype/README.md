# F28 local synchronization prototype

This is a standalone CommonJS/Node experiment. OG does not import or package
it. See [CONTRACT.md](./CONTRACT.md) for its guarantees and limits.

Run the pure and filesystem-focused tests from the checkout root:

```sh
node --test f28-sync-prototype/tests/*.test.js
```

The filesystem test creates exactly one fresh test-owned directory under the
mandatory `Logseq Test` root. It does not list that root, remove older runs, or
touch an existing graph. Generated state is retained outside Git and must never
be committed.
