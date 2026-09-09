# F28 source paths — build, package, validate

The **F28 source-path slices**: where OG's linked-reference breadcrumb cuts a
reference's ancestor path and leaves an inert `⋯`, one explicit,
keyboard-operable control opens the rest of that path in place, read-only — and
each disclosed level can itself be opened, by identity, with the mouse or the
keyboard.

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
| `checks/make-refpath-graph.js` | the synthetic graph: paths of 0, 2, 3, 4, 6, 7 and 14 ancestors, two branches sharing five levels, **six identical ancestors each with its own `id::`** (so THREE identical rows are disclosed and a destination chosen by label would be caught), two references under one parent, a second source page, a journal, a page link inside an elided ancestor, and a control page |
| `checks/packaged-app.js` | launch, refuse an outside path, open one graph, assert the loaded path — shared by both scenarios so their boundary evidence cannot drift apart |
| `checks/browser-noise.js` | ONE pre-existing browser condition, named and **correlated** rather than exempted by substring |
| `checks/lookup-fault.js` | a narrow, restored, clearly-labelled **simulated** lookup fault — the only way the refusal path can be seen on screen |
| `checks/refpath-baseline-checks.js` | the packaged OG-behaviour run |
| `checks/refpath-feature-checks.js` | the packaged feature run |
| `tests/feature-build.test.js` | identity, integrity, "this is none of the three earlier builds", and that the renderer really carries this feature |
| `tests/graph-fixture.test.js` | the fixture's own rules — including its DEPTH table checked against the indentation it actually writes, and that the identical-label chain runs past OG's limit with distinct identities |
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

## What the packaged feature run covers

`checks/refpath-feature-checks.js` runs in phases, and the ids are stable across
runs so two evidence files can be compared row by row:

| | |
|---|---|
| P0–P3 | the build's identity, a fresh graph, a refused outside path, the actually-loaded graph asserted before anything is touched |
| P4–P8 | OG's own list unchanged; the control exactly where OG cut the path; the 7-deep path; two panels at once; the 14-deep path across two presses |
| P9 | the keyboard, in a window whose global shortcut handler eats Enter |
| P10 | the rest of the list afterwards — no editor, no navigation, the filter, Korean and emoji |
| **P11** | **collapsing a path from inside it returns focus to that group's own control, and leaves the other group alone** |
| **P12** | **opening a disclosed level: by mouse and by keyboard, landing on the declared identity, an existing block rather than a created page, history return, three identical rows opening three different blocks, OG's own breadcrumb steps still re-scoping in place, and that group put back as it was found** |
| **N1** | **the negative path — a destination that cannot be opened. SIMULATED (see below): the visible refusal for each kind of bad answer, no navigation and no creation, the other group untouched, the explanation following its block across a redraw and moving to the panel when the row goes, the fault removed, and the same step opening for real afterwards** |
| P13 | the right sidebar — a named exclusion, measured live |
| P14 | the graph after the application closed, and every window error accounted for |

`P13`/`P14` were `P11`/`P12` before the navigation batch inserted two sections
ahead of them; `P13.9` is the former `P11.9`. `N1` runs between `P12` and `P13`
and is numbered apart from them on purpose, so the identifiers either side of it
stay comparable across evidence files.

## The simulated fault, and why there is one

`checks/lookup-fault.js` wraps `frontend.db/entity` or
`frontend.db/get-block-parent` for ONE identity, for the length of one press,
and restores it — verified by object identity, not by hope.

It exists because a destination cannot be made unavailable in the GRAPH without
removing the row before it can be pressed: deleting an ancestor takes it out of
the ancestor walk, and usually takes the whole reference with it. **Everything
it produces is simulated and is labelled so in the scenario output, in
`f28-refpath-feature-observations.json` (`negative.simulated`) and in the
readiness record.** It establishes that the product refuses correctly when a
lookup answers badly. It establishes nothing about which graph conditions
produce such an answer.

Narrowness is demonstrated rather than argued: while the fault is installed, a
probe of the faulted identity gets the bad answer and a probe of another
identity resolves to its real block, through the same function, in the same
instant. It writes nothing — the graph is hashed either side of the section as
well as across the run.

**Both packaged scenarios currently end one check short**, and always the same
one: OG logs a `[frontend.handler]` console line beside Chromium's ResizeObserver
notice, and the rule in `checks/browser-noise.js` refuses to exempt a handler
line because this harness cannot establish which event OG emitted it for. That
is the deliberate cost recorded in `F28_SOURCE_PATH_READINESS.md` §9 — do not
widen the rule to make the number go up, and do not re-run the scenario expecting
a different answer.

