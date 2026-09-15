# f28-identity-capture — live OG save/rename capture into persistent identity records

The approved single-machine integration batch connecting **actual completed OG
saves and renames** on one fresh synthetic graph to the validated persistent
file-identity and recovery records. See
[LIVE_CAPTURE_DESIGN.md](LIVE_CAPTURE_DESIGN.md) for the exact contract, and the
prior stages it builds on: the pure capture/comparison/identity modules and
their anchored store
([f28-sync-prototype](../f28-sync-prototype/PERSISTENT_IDENTITY_DESIGN.md)) and
the live observation runtime
([f28-observation](../f28-observation/README.md)).

This is **local capture only**. OG remains the sole writer of the test notes.
The adapter writes only its approved sidecar and device/recovery records. No
completed OG edit is reapplied as an incoming write. There is no cross-device
transport, no incoming application, no synchronization, and nothing here is
enabled in any normal or existing package.

## Process boundary

The packaged application is a new, separately packaged experimental build —
`Logseq OG F28 IdentityCapture` — compiled from the same source and closure
defines as the verified observation build. Its in-app bridge runtime is exactly
the established observation-only runtime: no persistence port, no
synchronization port, no sidecar write, no helper execution, and no renderer
filesystem access beyond OG's own existing behavior.

The experimental network control still refuses generic process launches inside
the app, and that protection is **not** disabled. The connection between the
observation stream and the anchored helper is made by an **external test-owned
coordinator** — a plain Node process started by the operator, outside the
application:

- it reads the sanitized in-memory cause stream through the existing read-only
  `__LOGSEQ_OG_BRIDGE_OBSERVATION__` page API;
- it invokes the existing anchored `identity_store_helper` for every graph-byte
  read and every record write.

No new privileged IPC interface, process-launch exception, access root or
weaker containment is added anywhere.

## Layout

```
src/f28-identity-capture/
  LIVE_CAPTURE_DESIGN.md        the pre-implementation design and contract
  README.md                      this file
  src/experiment-identity.js    the dedicated package identity
  src/experiment-forge.config.js packaging rules (own out dir, no makers/signing)
  checks/run-identity-capture.js the external coordinator (the live batch)
  checks/isolation-check.js      headless wiring check, no application involved
```

Build entry points live in `f28-origin/scripts` and are shared with the
observation build:

```
node f28-origin/scripts/build-experiment.js --identity-capture
node f28-origin/scripts/package-experiment.js --identity-capture
```

## Running

1. Build the anchored helper (binaries never enter Git):

   ```
   sh f28-sync-prototype/build-identity-helper.sh ../helpers/f28-identity-store-helper-x86_64
   ```

2. Build and package the application from a **clean** source tree (the build
   records `builtFrom.dirty`; the coordinator refuses a dirty build).

3. Run the isolation check first — it exercises the coordinator's exact wiring
   (observation shapes, capture batching, update derivation, duplicate
   collapse, re-feed refusal, stale pending, injected failure and recovery)
   against the real helper and modules with no application:

   ```
   F28_IDENTITY_HELPER=../helpers/f28-identity-store-helper-x86_64 \
     node f28-identity-capture/checks/isolation-check.js
   ```

4. Run the one coherent live batch:

   ```
   F28_IDENTITY_HELPER=../helpers/f28-identity-store-helper-x86_64 \
     node f28-identity-capture/checks/run-identity-capture.js
   ```

   `F28_OWNER_TOKEN` (64 hex) and `F28_IDENTITY_RUN_NAME` (safe component) are
   optional; fresh values are generated per run. Evidence is written to
   `development/evidence/f28-identity-capture-<stamp>.json` beside the
   checkout, with sanitized helper diagnostics in a sibling directory. The
   owned run under the two anchored roots is retained; the app profile is kept
   aside and the preserved profile restored by the existing fresh-profile
   tooling.

   If a run stops before the reopen verification, it can be completed with
   `node f28-identity-capture/checks/run-identity-capture.js --verify-reopen
   <evidence-file>`; diagnose any failure before another attempt.

## What the batch verifies

- explicit enrollment of only the fresh synthetic graph leaves note bytes
  unchanged;
- English and Korean saves through OG produce matching accepted records, with
  the nested observation seams collapsed into one logical save per group of
  causes sharing the exact graph-id + path + content-hash;
- a pending or failed cause — intent or queue flushing — is never completion
  evidence, and a later edit leaves the earlier completed save pending instead
  of falsely accepting it (the disk-ahead state is refused, not accepted);
- a Korean rename retains file identity and updates the exact path with
  unchanged content;
- a subsequent edit at the new path is captured correctly;
- duplicate observations do not create duplicate revisions, and re-fed
  completed evidence after acceptance is refused;
- a controlled record-persistence failure (`after-stage` at the device step,
  graph-first) preserves OG's saved note and OG's own save results, leaves the
  exact transaction outstanding with intent and evidence retained, refuses the
  re-issue over the moved sidecar, and recovery reconciles the exact state;
- observer health is verified at startup, before the quit and at reopen;
- a safe quit and reopen verify note content and persistent identity
  consistency across the restart, with no application running in between.

## Limits

One host, one fresh synthetic graph, one coherent batch. The cooperative lock
serializes participating helper invocations only. Injected failures establish
recovery classification, not power-loss durability; no real power-loss or
simultaneous-host test is run. Watcher-based incoming matching remains
synthetic-only: nothing here applies an incoming change, and nothing here is
usable cross-device synchronization.