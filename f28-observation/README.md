# F28 isolated OG bridge observation

This tooling builds and launches only the approved observation application:

- product: `Logseq OG F28 Observation`
- bundle: `com.logseq.logseq-og.f28observation`
- package: `logseq-og-f28-observation`
- profile directory: `observation-state`
- bridge schema/mode: `frontend.fs.og-sync-bridge.observation/1` / `observation-only`
- build output: `../out-f28-observation/`

Build and package from a clean `feature/f28-reference-paths` checkout:

```sh
node f28-origin/scripts/build-experiment.js --observation
node f28-origin/scripts/package-experiment.js --observation
```

The build guard asserts the dedicated identity, observation closure defines,
local assets, absent telemetry defines, active containment marker, and unchanged
pre-navigation network refusal. Packaging uses a local Electron archive and
produces an unsigned local application. It does not install into `/Applications`
or replace another package.

The runtime keeps its sanitized event sequence in memory and exposes a read-only
`__LOGSEQ_OG_BRIDGE_OBSERVATION__` reader. It installs no ACTIVE persistence,
incoming application, identity acceptance, sidecar, synchronization, or native
publisher port. Default builds leave both bridge defines false.

`checks/run-observation.js` creates at most one direct synthetic child of the
canonical `Logseq Test` root, or resumes the exact graph/profile named by one
evidence file. It never discovers other children of the shared root. Evidence,
profiles, application packages, screenshots, and graph content remain local and
are not Git inputs. `--verify-reopen <evidence>` performs only the required
contained reopen/display/quit verification.

## Live result, 2026-09-15 (first attempt — observation gap, preserved)

Build `2026-09-15T15-52-45-333Z-16574558`, from clean source
`d160c6ba4eeb05b6243cb1863c0039f27e513974`, preserved normal OG behavior:
English and Korean UI edits reached exact files, a Korean page rename removed
the old path and created the new path, and both edits rendered after reopening.

The observation goal did **not** pass in that run. The in-memory bridge recorded
only global preferences saves: no graph-page save pair, rename pair, or raw
watcher event. Its evidence and package are retained unchanged.

## Cause of that gap, and the confirmed result

The gap was in the observation **recorder**, not in hook placement. Every seam
above was reached. For a raw watcher observation carrying string content, the
sanitizer computed `:content-bytes` with cljs `count` over the `Uint8Array`
returned by `TextEncoder.encode`. A `Uint8Array` is not `array?` and implements
no `ICounted`, so `count` throws `No protocol method ICounted.-count`. The throw
escaped the recording `swap!`, so the watcher event itself was never recorded,
and `invoke-sync-port` caught it and latched `:blocked`. From that first watcher
event onward every `save-pending!`, `rename-intent!` and `observe-watcher!`
returned nil silently. The four retained events were the two nested
`write-plain-text-file!`/node pairs for the startup `preferences.json` write,
which happen before the first watcher event.

The reader exposed only the event list, so a permanently blocked observer looked
exactly like an observer that was never reached. The runtime now also exposes
sanitized `health()`: enabled/blocked, the fixed blocked stage and code, the
runtime instance the reader holds versus the one the seams resolve, and
hook-entry versus recorded-event counts. It carries no note content, no cause
payload and no error text, and never clears the latch.

Confirmed on build `2026-09-15T16-29-06-192Z-7cbf97ee`, from clean source
`b76b0ecde0eb58e7056de744819c3ef9d149a83c`, evidence
`f28-observation-2026-09-15T16-32-47-771Z.json`: **30/30 checks passed** on one
fresh synthetic graph. 80 sanitized events were recorded, the observer reported
healthy and unblocked at startup and after the live operations with the reader
and seams on the same runtime instance, and the English/Korean save pairs, the
Korean rename pair and the post-rename edit were all captured pending-before-
completed and bound to the exact operated graph. All 17 graph-directory watcher
observations named that graph; the one global-directory observation stayed
inside the owned isolated profile. Reopen displayed both exact saved edits and
the owned app quit with no retained process.

Rejected-operation behavior remains synthetic-only: no safe existing operation
produced a controlled live rejection, and permissions and paths were not
weakened to manufacture one.
