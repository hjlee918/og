# F28 source paths — build, package, validate

The **F28 source-path first slice**: where OG's linked-reference breadcrumb cuts
a reference's ancestor path and leaves an inert `⋯`, one explicit,
keyboard-operable control opens the rest of that path in place, read-only.

Specification: `project-notes/F28_SOURCE_PATH_SPEC.md`.
Readiness record: `project-notes/baseline/F28_SOURCE_PATH_READINESS.md`.

Everything here is tracked source. The application directory it produces
(`static/`) and the packaged app (`../out/`) are build outputs and are not.

## Two scenarios, and why there are two

| | what it establishes |
|---|---|
| `checks/refpath-baseline-checks.js` | what OG **already** does, in a build that does not contain this feature. It implements nothing. It is what makes the gap an observation rather than a reading of the source, and it refuses to run against a build whose renderer carries `frontend.util.f28_refpath` |
| `checks/refpath-feature-checks.js` | what this slice adds — on the **same fixture** — and that everything the baseline observed as working still works |

Both build their own fresh synthetic graph inside the permitted root and assert
the graph's bytes are unchanged after the application has closed.

## What this build is, and what it is NOT

This is a **feature build**, not the accepted pilot and not either accepted F27
feature build. It changes renderer source, so it rebuilds the renderer here and
says so:

| | accepted pilot (`f27-pilot/`) | outgoing (`f27-outgoing/`) | inline (`f27-inline/`) | this build (`f28-refpath/`) |
|---|---|---|---|---|
| renderer | the accepted artifacts, byte-identical | rebuilt on its branch | rebuilt on its branch | **rebuilt from this branch**; never labelled `5b34566ca` |
| main process | `release electron` with `electron.pilot/PILOT true` | the same | the same | the same, from the same unchanged guard sources |
| product | Logseq OG F27 Pilot | Logseq OG F27 Outgoing | Logseq OG F27 Inline | Logseq OG F28 RefPath |
| bundle id | `…f27pilot` | `…f27outgoing` | `…f27inline` | `com.logseq.logseq-og.f28refpath` |
| state root | `…/pilot-state` | `…/feature-state` | `…/inline-state` | `…/Logseq OG F28 RefPath/refpath-state` |
| ownership marker | `PILOT-OWNED.json` | `F27-OUTGOING-OWNED.json` | `F27-INLINE-OWNED.json` | `F28-REFPATH-OWNED.json` |
| package output | `development/f27-pilot/out` | `development/f27-outgoing-context/out` | `development/f27-inline-context/out` | `development/f27-inline-context/out` |

No two of these can claim each other's state, and none is installed, signed,
distributed or run as a daily application. **Do not run more than one at once.**

**This branch shares a checkout with `feature/f27-inline-context`, on purpose** —
it is cut from that branch's accepted commit in the same clone, so nothing is
duplicated. What must not be shared is the built application's identity, and
that is `src/feature-identity.js`. `tests/feature-build.test.js` asserts that
all three feature identities differ in every field that can claim state, that
the fields belonging to the compiled guard are identical, and that each
inherited build script still pins its own branch and therefore refuses to run
here.

The guard sources — `pilot-main.js`, `pilot-preflight.js`, `pilot-isolation.js`
and `pilot-boundary.js` — are the pilot's, shipped byte for byte, which
`tests/feature-build.test.js` asserts. Only `feature-identity.js` differs, and
it is shipped as `pilot-identity.js` because that is the name those sources
require.

Two constants in it are **not** this build's to change: `BOUNDARY_FILE` and
`BOUNDARY_SCHEMA` are the contract with the compiled guard (G5 in
`src/electron/electron/pilot.cljs`), which reads
`<state-root>/pilot-boundary.json` and accepts it only under the schema
`f27-pilot/boundary/1`. The regression reads those literals out of the guard
source rather than restating them.

## Reproduce

```sh
# from this clone's repo root, on branch feature/f28-reference-paths
node f28-refpath/scripts/build-feature.js       # gulp + renderer + guarded main
node f28-refpath/scripts/package-feature.js     # electron-forge package, darwin/x64
node f28-refpath/scripts/run-feature-tests.js   # pilot guards + this build's own + inherited
node f28-refpath/checks/refpath-feature-checks.js   # the feature, 0 content changes
```

The baseline run needs the build that predates this feature, which is why it
names it explicitly:

```sh
# with development/f27-inline-context/out/Logseq-OG-F27-Inline-darwin-x64 present
node f28-refpath/checks/refpath-baseline-checks.js
```

The ClojureScript tests are the ordinary ones:

```sh
clojure -M:test compile test && node static/tests.js -r f28
node static/tests.js -r f27      # the F27 suite, as the regression it is
```

`build-feature.js` refuses to run outside this clone and off this branch, so it
can never write into the accepted checkouts.

## Layout

| | |
|---|---|
| `src/feature-identity.js` | this build's identity; shipped as `pilot-identity.js` |
| `src/feature-forge.config.js` | packaging: no protocols, no signing, no notarization, no makers, no publishers |
| `scripts/build-feature.js` | gulp → `compile app` → `release electron` (PILOT) → assemble → manifest |
| `scripts/package-feature.js` | `electron-forge package`, output asserted before packaging |
| `scripts/run-feature-tests.js` | the pilot suite unmodified, this build's own, and the inherited F27 tooling suites |
| `checks/make-refpath-graph.js` | the synthetic graph: paths of 0, 2, 3, 4, 6, 7 and 14 ancestors, two branches sharing five levels, four identical ancestors, two references under one parent, a second source page, a journal, a page link inside an elided ancestor, and a control page |
| `checks/packaged-app.js` | launch, refuse an outside path, open one graph, assert the loaded path — shared by both scenarios so their boundary evidence cannot drift apart |
| `checks/browser-noise.js` | ONE pre-existing browser condition, named and **correlated** rather than exempted by substring |
| `checks/refpath-baseline-checks.js` | the packaged OG-behaviour run |
| `checks/refpath-feature-checks.js` | the packaged feature run |
| `tests/feature-build.test.js` | identity, integrity, "this is none of the three earlier builds", and that the renderer really carries this feature |
| `tests/graph-fixture.test.js` | the fixture's own rules — including its DEPTH table checked against the indentation it actually writes |
| `tests/browser-noise.test.js` | the correlation rule, driven deterministically, including the case it must NOT excuse |

## The one pre-existing condition this feature's runs name

Chromium reports `ResizeObserver loop completed with undelivered
notifications.` through `window.onerror` when a resize callback causes another
resize in the same frame. It is a browser signal, not an exception. OG's global
handler filters `window.onerror` through `frontend.error/ignored?`, whose list
contains the OLDER wording (`ResizeObserver loop limit exceeded`) and not this
one — so the notice passes the filter and OG emits two console errors from it:
the message, and a `[frontend.handler]` line for the undefined exception beside
it. It arrives when a long page is scrolled, which is what reading a
linked-references list to the end requires.

`checks/browser-noise.js` names it, and does so by **correlation**: the
`[frontend.handler]` line is excused only when such a notice arrived
immediately before it, within one second. A `[frontend.handler]` error with no
notice in front of it is not excused, and that is pinned by a deterministic
test. Both scenarios report the count with the rule applied and the count
without it, so nothing is hidden.

This rule lives here rather than in `f27-inline/checks/error-classifier.js`,
which is part of accepted F27 evidence and whose acceptance record names an
over-broad substring exemption as the thing that made a general claim about
runtime errors worthless. Widening it would repeat that mistake in a new place.

## Graph data

`project-notes/DATA_ACCESS_GUARDRAIL.md` controls, and nothing here relaxes it.

Graph data is used **only** inside
`~/Library/Mobile Documents/com~apple~CloudDocs/Logseq Test`, enforced by
`f27-pilot/checks/allowed-root.js` with traversal and symlink-escape rejection,
and by the application's own G5 boundary. Each run builds its own fresh,
uniquely named synthetic graph. Nothing is ever deleted, reset or renamed, and
no earlier run's folder is touched.

Both runs assert the **actual** loaded graph path before any feature
interaction, and compare content hashes after the application has closed. No
personal graph is opened, read or enumerated, and the installed application is
never launched.

The older preview scripts under `f27-preview/` default to fixture directories
**outside** that root. They are not used by this batch and must not be run with
their defaults.
