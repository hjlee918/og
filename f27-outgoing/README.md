# F27 outgoing context — build, package, validate

The **F27 outgoing first slice**: *Links in this block* — the block references
written **inside** a block, shown inside an F27 reference context, as a
traversal direction of their own.

Everything here is tracked source. The application directory it produces
(`static/`) and the packaged app (`../out/`) are build outputs and are not.

## What this is, and what it is NOT

This is a **feature build**, not the accepted pilot. It changes renderer source,
so it rebuilds the renderer here and says so:

| | accepted pilot (`f27-pilot/`) | this feature build (`f27-outgoing/`) |
|---|---|---|
| renderer | the accepted artifacts, passed through byte-identical and measured | **rebuilt from this branch**; never labelled `5b34566ca` |
| main process | `release electron` with `electron.pilot/PILOT true` | the same, from the same unchanged guard sources |
| product | Logseq OG F27 Pilot | Logseq OG F27 Outgoing |
| bundle id | `com.logseq.logseq-og.f27pilot` | `com.logseq.logseq-og.f27outgoing` |
| state root | `…/Logseq OG F27 Pilot/pilot-state` | `…/Logseq OG F27 Outgoing/feature-state` |
| ownership marker | `PILOT-OWNED.json` | `F27-OUTGOING-OWNED.json` |
| package output | `development/f27-pilot/out` | `development/f27-outgoing-context/out` |

The two builds cannot claim each other's state, and neither is installed,
signed, distributed or run as a daily application. **Do not run both at once.**

The guard sources — `pilot-main.js`, `pilot-preflight.js`, `pilot-isolation.js`
and `pilot-boundary.js` — are the pilot's, shipped byte for byte, which
`tests/feature-build.test.js` asserts. Only `feature-identity.js` differs, and
it is shipped as `pilot-identity.js` because that is the name those sources
require.

Two constants in it are **not** this build's to change: `BOUNDARY_FILE` and
`BOUNDARY_SCHEMA` are the contract with the compiled guard (G5 in
`src/electron/electron/pilot.cljs`), which reads
`<state-root>/pilot-boundary.json` and accepts it only under the schema
`f27-pilot/boundary/1`. Renaming the schema — which the first version of this
file did — leaves the graph root unconfigured, and the application then refuses
**every** graph path, the permitted one included. That is the guard failing
closed, and it is exactly what it should do; the regression is in
`tests/feature-build.test.js`, read from the guard source rather than restated.

## Reproduce

```sh
# from this feature clone's repo root, on branch feature/f27-outgoing-context
node f27-outgoing/scripts/build-feature.js       # gulp + renderer + guarded main
node f27-outgoing/scripts/package-feature.js     # electron-forge package, darwin/x64
node f27-outgoing/scripts/run-feature-tests.js   # 74 pilot + 23 feature checks
node f27-outgoing/checks/outgoing-loaded-graph-checks.js   # 45 packaged checks
```

The ClojureScript tests are the ordinary ones:

```sh
clojure -M:test compile test && node static/tests.js -r f27
```

`build-feature.js` refuses to run outside this clone and off this branch, so it
can never write into the accepted checkouts. It asserts, and stops on any of
them failing:

* the renderer's asset path is the **local** `/static/js/cljs-runtime/` — a
  `release` build of `:app` would point at `https://asset.logseq.com/static/js`;
* the renderer carries **no** Sentry or PostHog closure define;
* the renderer's revision equals what this checkout describes as;
* the main bundle is self-contained, carries the guard marker and does **not**
  carry the inert marker;
* the freshly written manifest passes the very preflight the application runs at
  startup, verified against the identity that will actually ship.

## Layout

| | |
|---|---|
| `src/feature-identity.js` | this build's identity; shipped as `pilot-identity.js` |
| `src/feature-forge.config.js` | packaging: no protocols, no signing, no notarization, no makers, no publishers |
| `scripts/build-feature.js` | gulp → `compile app` → `release electron` (PILOT) → assemble → manifest |
| `scripts/package-feature.js` | `electron-forge package`, output asserted before packaging |
| `scripts/run-feature-tests.js` | the pilot suite unmodified, plus this build's own |
| `checks/make-outgoing-graph.js` | this batch's synthetic graph, from templates in that file |
| `checks/outgoing-batch-graph.js` | one graph per batch, reused only after per-file checks |
| `checks/outgoing-loaded-graph-checks.js` | the packaged, loaded-graph scenario |
| `tests/feature-build.test.js` | identity, integrity and "this is not the accepted pilot" |
| `tests/graph-fixture.test.js` | the fixture's own rules, without touching the graph root |

## Graph data

`project-notes/DATA_ACCESS_GUARDRAIL.md` controls, and nothing here relaxes it.

Graph data is used **only** inside
`~/Library/Mobile Documents/com~apple~CloudDocs/Logseq Test`, enforced by
`f27-pilot/checks/allowed-root.js` with traversal and symlink-escape rejection,
and by the application's own G5 boundary. One fresh, uniquely named synthetic
graph is built for this batch and reused only after every one of its files has
been proved contained, a regular file, and byte-identical to this batch's
templates. Nothing is ever deleted, reset or renamed, and no earlier run's
folder is touched.

The loaded-graph run asserts the **actual** loaded graph path before any feature
interaction, and compares content hashes after the application has closed. No
personal graph is opened, read or enumerated, and the installed application is
never launched.

The older preview scripts under `f27-preview/` default to fixture directories
**outside** that root. They are not used by this batch and must not be run with
their defaults.
