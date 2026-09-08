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
node f27-inline/checks/inline-loaded-graph-checks.js   # static reading, 0 content changes
node f27-inline/checks/inline-lifecycle-checks.js      # an open panel, graph changed ON DISK
node f27-inline/checks/inline-transaction-checks.js    # an open panel, changed BY THE APPLICATION
node f27-inline/checks/inline-refresh-checks.js        # reading an open panel again, on purpose
```

The four packaged scenarios are separate sessions on separate graphs on purpose.
The first asserts that **nothing** in its graph changed; the other three change
theirs deliberately, and by different means — one writes the files, which reaches
OG through its file watcher, and two never touch a file at all and go through
OG's editor and `logseq.api`. Those claims cannot share a run, and the two write
paths behave differently enough that neither substitutes for the other (see
below). Run them one at a time: **do not run more than one of these builds at
once.**

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
| `checks/inline-loaded-graph-checks.js` | the packaged, loaded-graph scenario — STATIC reading, asserts zero content change (section I is this slice) |
| `checks/make-lifecycle-graph.js` | a MUTABLE synthetic graph changed by WRITING ITS FILES, with every write declared as a whole-file body and one page that is never written |
| `checks/inline-lifecycle-checks.js` | the packaged EXTERNAL-FILE scenario: an OPEN panel while the graph changes on disk |
| `checks/make-transaction-graph.js` | a MUTABLE synthetic graph nothing writes but the application itself |
| `checks/inline-transaction-checks.js` | the packaged NORMAL-TRANSACTION scenario: the same lifecycle through OG's own editor and API, plus context changes that are not the target's text, plus listener ownership |
| `checks/make-refresh-graph.js` | a MUTABLE synthetic graph for the refresh scenario, with incoming sources that appear and disappear, a mutual pair, an identity nobody wrote, a control page and a reading page that is a second control |
| `checks/inline-refresh-checks.js` | the packaged EXPLICIT-REFRESH scenario: an incoming source added and removed through the ordinary API while the section is open, the keyboard, two independent panels, the inner walk and its reset, a cycle, a missing target, and a refresh-only burst measured for writes, listeners, re-index and navigation |
| `tests/feature-build.test.js` | identity, integrity and "this is neither accepted build" |
| `tests/graph-fixture.test.js` | the read-only fixture's own rules, without touching the graph root |
| `tests/mutable-fixture.test.js` | both mutable fixtures' rules, including that their end-state assertions could actually fail |
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

## Reading an open panel again, on purpose

Everything the panel shows is derived from the database on each render — except
one section. The incoming-reference explorer reads a level when the reader asks
for it and then REPLAYS what it read, because Back and a path jump re-display a
level without reading anything; that is what retaining the history is for
(B3/B7). So a section left open while the graph changes keeps showing the level
it read.

**Refresh context** is the explicit answer, and the panel says in words that its
lists were read rather than being live. It advances a reading GENERATION carried
inside the panel's key-guarded state, which:

* re-resolves the target and re-derives every other section, because the panel
  re-renders;
* discards the incoming-reference explorer's walked path and reads its **root**
  level again — the section stays open and is re-read in place, and the inner
  traversal returning to the panel's own target is stated rather than implied;
* leaves the panel, its first disclosure, *Show context*, the ancestor batch,
  the descendant branches and the outgoing paging exactly as they were, none of
  which hold a stale answer;
* reaches **one** panel. The generation lives in the mounted occurrence's own
  atom and the key guard refuses a refresh under another reference's key, so a
  second panel open at the same time goes on showing what IT read;
* navigates nothing, re-indexes nothing, transacts nothing and remounts nothing
  outside the panel — and adds and removes no connection listener, because
  `rebind!` compares connection identity. Measured in the scenario on both sides
  of a six-press burst, not asserted.

`refresh-panel` in `frontend.util.f27-inline` and `reset-trail` /
`awaiting-start?` in `frontend.util.f27-inbound` are pure and are tested without
a DOM. The reset itself happens in `f27-row-inbound`'s `:after-render` — never
`:before-render`, which is React's `componentWillUpdate`, where Rum's
`request-render` would perform exactly the illegal synchronous update React
forbids.

## Keeping an open panel true

A panel that is open when its target changes cannot be kept true by the reactive
query system, and the reason is measured rather than assumed:
`outliner.pipeline/invoke-hooks` — the only caller of `react/refresh!` — is
guarded by `(not (:from-disk? tx-meta))`, and the file watcher's `alter-file`
passes exactly that. So on a from-disk change **no** reactive query is refreshed:
not `::block`, not `::page-blocks`, not even a `:custom` key. What OG does
instead is `re-render-root!`, which `rum/static` stops from reaching the block
subtree — which is why OG's own inline reference text is itself stale after such
a change until its host re-renders for another reason. This slice does not
change that, and the lifecycle scenario records it as an observation.

The panel therefore listens to the datascript **connection**, which every
transaction reaches whatever its metadata carries. It decides from the
transaction's own datoms — `f27-inline-watch/touches?` — against a small set of
entity ids gathered when the panel last rendered: the target, its parent, its
page and the ancestors the breadcrumb shows. A child arriving or a block
starting to refer to the target is not in that set and does not need to be:
those transactions POINT at the target through `:block/parent` and
`:block/refs`. So an open panel costs one pass over each transaction's datoms
and no database read at all; a closed one costs nothing.

The subscription is registered in the panel's `:did-mount` and removed in
`:will-unmount`, from the **exact connection it was added to** — a re-index
REPLACES the connection, so asking the application again at unmount would
unlisten from the new one and leave this listener on the old one forever. If the
connection is replaced while a panel is open, the next render rebinds it.
`frontend.util.f27-inline-watch` owns all of this and is tested against real
`d/create-conn` connections, reading datascript's own listener table.

### What the two write paths do differently

Worth knowing before reading either scenario:

| | files written outside the app | OG's editor / `logseq.api` |
|---|---|---|
| reactive queries refreshed | **no** (`invoke-hooks` skips `:from-disk?`) | yes |
| OG's own inline reference text | does not converge; the run observed none within its 30-second budget | converges |
| deleting a referenced block | the reference survives its target, so the panel reaches its honest **unavailable** state | OG **substitutes the deleted block's text** into every referrer, so the reference — and with it the control and the panel — ceases to exist |

The panel converges on both paths. The unavailable state is only reachable on
the first, and that is where it is asserted.

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
