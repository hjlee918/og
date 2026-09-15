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

## Live result, 2026-09-15

Build `2026-09-15T15-52-45-333Z-16574558`, from clean source
`d160c6ba4eeb05b6243cb1863c0039f27e513974`, preserved normal OG behavior:
English and Korean UI edits reached exact files, a Korean page rename removed
the old path and created the new path, and both edits rendered after reopening.

The observation goal did **not** pass. The in-memory bridge recorded only global
preferences saves. It recorded no graph-page save pair, rename pair, or raw
watcher event, despite gated probes at the common filesystem dispatch, Node and
File System Access implementations, and the production save-tree boundary.
Therefore no live graph event ordering or watcher matching is claimed. Synthetic
suites continue to cover the bridge contracts, but they are not live evidence.
No broad permission/path failure was manufactured; rejected-operation behavior
remains synthetic-only coverage.
