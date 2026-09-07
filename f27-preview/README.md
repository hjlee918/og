# F27 preview tooling

Small scripts that make the accepted F27 work easy to look at, using synthetic
demonstration graphs. They are development tooling, not part of the
application, and nothing here ships in a build.

| File | What it is |
|---|---|
| `preview.js` | the only supported way to start the preview |
| `build-identity.js` | which commit the preview is actually running |
| `graph-store.js` | the ownership, refusal and archive rules, in one place |
| `make-integrated-graph.js` | creates the INTEGRATED demonstration graph |
| `make-preview-graph.js` | creates the original USER demonstration graph |
| `walkthrough-integrated.js` | the consolidated scenario for the integrated graph |
| `walkthrough-user.js` | the original five-action scenario, unchanged |
| `lifecycle-check.js` | fast checks for shutdown, build identity and graph rules |

## Starting it

```
cd <your checkout>/development/f27-slice-1
node f27-preview/preview.js
```

That opens the **integrated** demonstration graph: one reference panel from
which every accepted F27 slice can be seen — compact references and a Crystal
marker, ancestors, children and inbound navigation, pictures and attachments, a
block embed and a page excerpt, and the paths and constructs a panel refuses.

- `--demo user` opens the ORIGINAL user demonstration graph instead. It is
  preserved exactly as it was; nothing about the integrated graph resets,
  overwrites or renames it.
- `--reset` archives *the chosen* demonstration graph and builds a fresh one.
- `--self-check` is a maintenance mode: it performs that graph's whole scenario
  automatically, writes a result file and exits.

The reader-facing guide — what to click and what you should see — lives in the
project notes beside this checkout, not in this repository:
`project-notes/F27_USER_PREVIEW_GUIDE.md`.

## Build identity

`preview.js` will not open a window whose code it cannot name.

`shadow-cljs.edn` compiles `git describe --long --always --dirty` into the
closure define `frontend.config.REVISION`, which lands near the top of
`static/js/main.js`. Before anything is launched, `build-identity.js` reads it
and compares it with what this checkout reports now, and compares every
compiled artifact against the sources the build actually reads
(`src/main`, `src/electron`, `src/resources`, `src/dev-cljs`, `deps`,
`deps.edn`, `shadow-cljs.edn`, `externs.js`, the Tailwind inputs and
`resources`). `src/test` is deliberately not among them: no test namespace is
reachable from `frontend.core/init` or `electron.core/main`, so editing a test
does not make a build stale.

- a MISSING artifact stops the run and is named;
- a renderer built from **another commit** stops the run and both revisions are
  printed;
- an artifact **older than a source the build reads** stops the run — this is
  what covers `static/electron.js` and `static/css/style.css`, which carry no
  revision of their own;
- a **dirty working tree** does not stop the run, but is reported as
  *unprovable*: `<sha>-dirty` names a commit and not a state, so two different
  uncommitted trees describe identically.

The rebuild command is printed with the refusal. The order matters — `gulp`
cleans `static/js`, so it runs first:

```
yarn gulp:build
clojure -M:cljs compile app electron
```

This is a **local test preview**. It is not an installer, not a release, and
not a replacement for the application the user runs every day.

## Where things are

Everything the preview generates is written **outside this repository**, so no
profile, graph or binary can be committed by accident:

- integrated graph — `development/f27-preview/graph/f27-integrated-demo`
- user graph — `development/f27-preview/graph/f27-preview-demo`
- archived graphs — `development/f27-preview/graph-archive/<name>-<timestamp>`
- launch profiles — `development/f27-evidence/preview-<timestamp>`
- self-check results and screenshots — `development/f27-preview/`

One further file is written **one level above** the integrated graph:
`development/f27-preview/graph/outside-sentinel.png`. It is a real, readable
picture placed exactly where `../assets/../../…` resolves to, so "a path that
climbs out of the graph never reaches the screen" is something the screen could
contradict rather than a statement about an absent file.

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
preservation claim. A symbolic link inside the graph is recorded as the link it
is rather than read through.

The byte comparison is a report, not a guarantee: the F27 reference panels are
read-only, but this launcher does not disable OG's ordinary editor, so the
demonstration notes can legitimately change.

The window's own error log is reported too. Two kinds of noise are OG's own and
predate this work — its startup network attempts, and any deprecation notice it
prints — and they are named rather than folded into a "clean" claim.

## Demonstration graphs — never deleted

Neither generator has a delete path at all, and both use the same rules
(`graph-store.js`).

- **Create** refuses if anything is already there.
- **Reset** *renames* the existing graph into `graph-archive/` with a timestamp,
  then builds a fresh one.
- An **incomplete** graph — one whose `logseq/config.edn` is missing, or which
  is short of its pages or its files — is refused rather than rebuilt over,
  because the reader may have edited the notes.
- A directory that carries neither its generator's signature nor its marker file
  is treated as **not ours** and is never moved or removed, with or without
  `--reset`.
- Every write and every archive move first checks that the target is inside the
  preview directory and is not reached through a symbolic link, and an asset
  name must be a plain file name rather than a path.
- **Preparing one graph never touches the other.** `lifecycle-check.js` builds
  and resets the integrated graph over an edited user graph and asserts the
  user graph is unchanged.

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
a fake digest, a fake checkout — and temporary synthetic directories. It covers
setup failure after launch, early cancellation, the deadline during startup and
during `--self-check`, a failed close, a hanging close, idempotent cleanup and
the close-before-digest ordering; both generators' refusal, archive, foreign,
symlink and asset-name rules, and that neither graph disturbs the other; every
build-identity verdict (missing, wrong commit, stale by time, dirty, silent);
and the demonstration-graph selection. It starts no application, so a real
launch still has to be checked with the normal command or `--self-check`.
