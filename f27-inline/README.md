# F27 inline reference context — build, package, validate

The **F27 inline-context first slice** (C6): an explicit, keyboard-accessible
control beside an ordinary inline block reference that opens the **target's**
existing safe F27 context in place, without navigating away.

Specification: `project-notes/F27_INLINE_CONTEXT_SPEC.md`.

Everything here is tracked source. The application directory it produces
(`static/`) and the packaged app (`../out/`) are build outputs and are not.

## What this is, and what it is NOT

This is a **feature build**, not the accepted pilot and not the accepted
outgoing build. It changes renderer source, so it rebuilds the renderer here
and says so:

| | accepted pilot (`f27-pilot/`) | outgoing (`f27-outgoing/`) | this build (`f27-inline/`) |
|---|---|---|---|
| renderer | the accepted artifacts, byte-identical | rebuilt on its branch | **rebuilt from this branch**; never labelled `5b34566ca` |
| main process | `release electron` with `electron.pilot/PILOT true` | the same | the same, from the same unchanged guard sources |
| product | Logseq OG F27 Pilot | Logseq OG F27 Outgoing | Logseq OG F27 Inline |
| bundle id | `…f27pilot` | `…f27outgoing` | `com.logseq.logseq-og.f27inline` |
| state root | `…/Logseq OG F27 Pilot/pilot-state` | `…/Logseq OG F27 Outgoing/feature-state` | `…/Logseq OG F27 Inline/inline-state` |
| ownership marker | `PILOT-OWNED.json` | `F27-OUTGOING-OWNED.json` | `F27-INLINE-OWNED.json` |
| package output | `development/f27-pilot/out` | `development/f27-outgoing-context/out` | `development/f27-inline-context/out` |

No two of these can claim each other's state, and none is installed, signed,
distributed or run as a daily application. **Do not run more than one at once.**

`f27-outgoing/` is still in this tree, inherited from the accepted base commit.
Its build script pins `feature/f27-outgoing-context`, which this checkout is not
on, so it refuses to run here — asserted in `tests/feature-build.test.js`.

The guard sources — `pilot-main.js`, `pilot-preflight.js`, `pilot-isolation.js`
and `pilot-boundary.js` — are the pilot's, shipped byte for byte, which
`tests/feature-build.test.js` asserts. Only `feature-identity.js` differs, and
it is shipped as `pilot-identity.js` because that is the name those sources
require.

Two constants in it are **not** this build's to change: `BOUNDARY_FILE` and
`BOUNDARY_SCHEMA` are the contract with the compiled guard (G5 in
`src/electron/electron/pilot.cljs`), which reads
`<state-root>/pilot-boundary.json` and accepts it only under the schema
`f27-pilot/boundary/1`. Renaming the schema leaves the graph root unconfigured
and the application then refuses **every** graph path, the permitted one
included. That is the guard failing closed; the regression reads the literals
out of the guard source rather than restating them.

## Reproduce

```sh
# from this feature clone's repo root, on branch feature/f27-inline-context
node f27-inline/scripts/build-feature.js       # gulp + renderer + guarded main
node f27-inline/scripts/package-feature.js     # electron-forge package, darwin/x64
node f27-inline/scripts/run-feature-tests.js   # pilot guards + this build's own
node f27-inline/checks/inline-loaded-graph-checks.js   # the packaged scenario
```

The ClojureScript tests are the ordinary ones:

```sh
clojure -M:test compile test && node static/tests.js -r f27
```

`build-feature.js` refuses to run outside this clone and off this branch, so it
can never write into the accepted checkouts. It asserts, and stops on any of
them failing:

* the renderer's asset path is the **local** `/static/js/cljs-runtime/`;
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
| `checks/make-inline-graph.js` | this batch's synthetic graph — the outgoing fixture plus this slice's reading pages |
| `checks/inline-batch-graph.js` | one graph per batch, reused only after per-file checks |
| `checks/error-classifier.js` | **the harness improvement this batch owes**: phase-correlated window-error classification |
| `checks/inline-loaded-graph-checks.js` | the packaged, loaded-graph scenario (section I is this slice) |
| `tests/feature-build.test.js` | identity, integrity and "this is neither accepted build" |
| `tests/graph-fixture.test.js` | the fixture's own rules, without touching the graph root |
| `tests/error-classifier.test.js` | the classification rules, driven deterministically |

## Window errors: correlation, not a substring

The outgoing acceptance record named the previous classifier as too broad: it
exempted **every** `frontend.handler.web.nfs` error that did not contain the
test graph path, so no general claim about runtime errors could rest on it.

`checks/error-classifier.js` replaces that. Each captured error carries the
**phase** and **operation** it arrived in. An error is expected only when it
arrived in the deliberate negative-test phase, while that phase's own operation
was in flight, and its shape is one the refusal produces. The same path-free NFS
error arriving during feature use **fails** — proved by a deterministic
regression, by name, in `tests/error-classifier.test.js`. An error mentioning
this run's own graph is never expected, anywhere. Expected refusals stay
visible: they are counted, named and printed.

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
