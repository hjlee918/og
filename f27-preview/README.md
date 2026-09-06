# F27 preview tooling

Three small scripts that make the accepted F27 slices easy to look at, using a
synthetic demonstration graph. They are development tooling, not part of the
application, and nothing here ships in a build.

| File | What it is |
|---|---|
| `preview.js` | the only supported way to start the preview |
| `make-preview-graph.js` | creates the synthetic demonstration graph |
| `lifecycle-check.js` | fast checks for shutdown and graph-preservation rules |

## Starting it

```
cd <your checkout>/development/f27-slice-1
node f27-preview/preview.js
```

`--reset` archives the existing demonstration graph and builds a fresh one.
`--self-check` is a maintenance mode: it performs the guided walkthrough
automatically, writes a result file and exits.

The user-facing walkthrough — what to click and what you should see — lives in
the project notes beside this checkout, not in this repository:
`project-notes/F27_USER_PREVIEW_GUIDE.md`.

## Where things are

Everything the preview generates is written **outside this repository**, so no
profile, graph or binary can be committed by accident:

- demonstration graph — `development/f27-preview/graph/f27-preview-demo`
- archived graphs — `development/f27-preview/graph-archive/<name>-<timestamp>`
- launch profiles — `development/f27-evidence/preview-<timestamp>`
- self-check results and screenshot — `development/f27-preview/`

## Lifecycle

One controller owns the whole run, and it is installed **before** the
application is launched:

- **SIGINT, SIGTERM, SIGHUP and terminal end-of-input** are handled from the
  start, not from the moment the preview is ready. End-of-input counts only when
  stdin is a terminal, so a closed pipe is not mistaken for a cancellation.
- **The session deadline covers the whole run** — startup, the interactive wait
  and `--self-check` alike — rather than only the wait after READY.
- **Every exit path runs the same idempotent cleanup**: success, a refusal, a
  throw during setup, a signal, or the deadline. The original error is preserved
  and reported after cleanup, never instead of it.
- **A partially launched application is still closed.** `preview.js` passes an
  `onApp` callback to the guarded launcher, which hands the application over as
  soon as it exists, so a failure part-way through a launch has something to
  close. The guarded launcher also closes the application itself when a caller
  did not pass `onApp`.
- **Only this launcher's own child is ever signalled**, and only after a
  graceful close has already failed. No process is matched by name and nothing
  unrelated is touched.
- Enter typed during startup is remembered and honoured once the preview is
  ready, rather than being swallowed.

## Shutdown order

The application is closed and given time to settle **first**; only then is the
demonstration graph hashed. A close that did not succeed is reported as a
failure, and the byte reading taken after it is explicitly *not* presented as a
preservation claim.

The byte comparison is a report, not a guarantee: the F27 reference panels are
read-only, but this launcher does not disable OG's ordinary editor, so the
demonstration notes can legitimately change.

## Demonstration graph — never deleted

`make-preview-graph.js` has no delete path at all.

- **Create** refuses if anything is already there.
- **Reset** *renames* the existing graph into `graph-archive/` with a timestamp,
  then builds a fresh one.
- An **incomplete** graph — for example one whose `logseq/config.edn` is missing
  — is refused rather than rebuilt over, because the reader may have edited the
  notes. (This is the case the previous version silently deleted.)
- A directory that carries neither this generator's signature nor its
  `.f27-preview-demo` marker is treated as **not ours** and is never moved or
  removed, with or without `--reset`.
- Every write and every archive move first checks that the target is inside the
  preview directory and is not reached through a symbolic link.

## Safety rules this tooling keeps

- **Every launch goes through `development/f27-evidence/isolated-launch.js`.**
  There is no direct Electron or app-bundle launch here and no fallback. The
  guarded path refuses to start unless the profile and the whole environment
  resolve inside the evidence directory, and it replaces the environment rather
  than inheriting it. Background: `INCIDENT_2026-09-05_UNISOLATED_LAUNCH.md`.
- **The graph is asserted, not assumed.** `preview.js` hands the application the
  demonstration folder through the application's own test hook, then polls
  `get_current_graph()` and compares the path it gets back. If it does not
  match, the launcher clicks nothing further, prints manual instructions and
  closes.
- **No native folder dialog is acted on.** If one ever appears, the launcher
  stops rather than guessing — the chooser is known to remember a location from
  outside the isolated profile.
- **Foreground only.** No background watcher, no auto-restart, no login item.
- **The installed Logseq OG is not managed by this tooling.** It is never
  started, stopped, replaced or configured, and no claim is made about whether
  it is running.
- **Bounded session.** The run closes itself 12 minutes after it starts, the
  project's standing per-session bound.

## Checking it

```
node f27-preview/lifecycle-check.js
```

Runs in seconds using small doubles — a fake application handle, a fake launch,
a fake digest — and temporary synthetic directories. It covers setup failure
after launch, early cancellation, the deadline during startup and during
`--self-check`, a failed close, a hanging close, idempotent cleanup, and the
close-before-digest ordering; plus the generator's refusal, archive, foreign
directory and symlink rules. It starts no application, so a real launch still
has to be checked with the normal command or `--self-check`.

## Build artifacts

`preview.js` checks for the compiled renderer, the compiled main process, the
stylesheet and the Electron binary before it launches, and stops with the
rebuild command if any is missing. The order matters — `gulp` cleans
`static/js`, so it runs first:

```
yarn gulp:build
clojure -M:cljs compile app electron
yarn cljs:test
```
