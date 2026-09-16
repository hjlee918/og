# f28-incoming — applying an incoming change without overwriting a newer local edit

The approved first slice in which the **external coordinator writes note bytes**.
Every earlier stage kept OG as the sole note writer. See
[INCOMING_CHANGE_DESIGN.md](../f28-sync-prototype/INCOMING_CHANGE_DESIGN.md) for
the contract and [RESULTS.md](../f28-sync-prototype/RESULTS.md), section
"Incoming change application (2026-09-15)", for the verified results.

Scope: **creates and updates only**, one host, fresh synthetic data, Intel, with
the test application **closed** during application. The "second replica" is a
state this same process builds in memory — there is no network, no peer, no
transport and no second device.

## The application gains nothing

This reuses the accepted `Logseq OG F28 IdentityCapture` package **unmodified
and not rebuilt**. Its bridge runtime is observation-only: no persistence port,
no synchronization port, no helper execution, no new IPC, no process-launch
exception, no network permission. The coordinator is a plain Node process the
operator starts outside the application.

## Layout

```
src/f28-incoming/
  README.md                        this file
  checks/app-closed-gate.js        the gate proving the owned app has exited
  checks/isolation-check.js        headless wiring check, no application involved
  checks/run-incoming-application.js  the live batch
```

The applier itself lives with the modules it reuses, at
`f28-sync-prototype/src/incoming-application.js`.

## Running

1. Build the anchored helper (binaries never enter Git):

   ```sh
   sh f28-sync-prototype/build-identity-helper.sh ../helpers/f28-identity-store-helper-x86_64
   ```

2. Run the focused suite, then the isolation check, before anything live:

   ```sh
   F28_IDENTITY_HELPER=../helpers/f28-identity-store-helper-x86_64 \
   F28_RUN_NAME=<fresh-owned-run> F28_OWNER_TOKEN=<64-hex-token> \
   F28_CASE_SUFFIX=<new-case-suffix> \
     node --test f28-sync-prototype/tests/incoming-application.test.js

   F28_IDENTITY_HELPER=../helpers/f28-identity-store-helper-x86_64 \
     node f28-incoming/checks/isolation-check.js
   ```

3. Run the live batch. It creates its own fresh owned run under both anchored
   roots, swaps the app profile aside and restores it, and writes evidence to
   `development/evidence/` beside the checkout — never a Git input.

   ```sh
   F28_IDENTITY_HELPER=../helpers/f28-identity-store-helper-x86_64 \
     node f28-incoming/checks/run-incoming-application.js
   ```

Neither shared root is ever listed. Retention and process state are confirmed
with a directory-existence check on each exact recorded owned path and a process
check on the exact packaged executable name.

## What the live batch verifies

OG creates one English and one Korean page; this device enrols them; a synthetic
second replica proposes one update and one create; a preview is produced with the
app running and writes nothing; **application is refused while the app is
running**; the app quits cleanly and its exit is proven; both files are applied
with exact bytes while an untouched note stays byte-identical; identity is
accepted at the new revision and the sidecar stays portable; the journal closes;
and after a reopen OG renders both incoming changes with unchanged note hashes
and unchanged accepted identity.

## Limits

**One incoming transaction per owned run.** The journal slot is never reused: a
retained journal — open, closed or unparseable — refuses a second proposal at
both the preview and the application phase, because it holds the only retained
copy of its transaction's before-images and this slice has no approved way to
archive that durably. Another experiment uses a fresh owned run.

**Not every recovery case has a regression.** The graph-first device-step
boundary, an unrelated outstanding transaction, a falsely-closed journal and a
substituted binding are covered. The uncertain-clear branch, `profile-first`
ordering, an intent-step failure and a failure during recovery's own roll-forward
write are handled by the same typed refusals but have no test of their own.

One host, one fresh synthetic graph, one coherent batch. Per-file application is
not whole-graph atomicity: an interruption leaves a mixed state. The cooperative
lock serializes participating helper invocations only — Finder, cloud agents and
external editors are not excluded, and the helper's check-then-rename race
against them remains open. Two concurrent coordinators were not run. The
app-closed gate proves one application has exited and excludes nothing else.
Injected failures establish recovery classification, not power-loss durability.
The journal's validations establish consistency, not authenticity against a
writer who can reach the owned profile directory. This is not cross-device
synchronization, and nothing is enabled in any normal or existing package.
