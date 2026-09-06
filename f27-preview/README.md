# F27 preview tooling

Two small scripts that make the accepted F27 slices easy to look at, using a
synthetic demonstration graph. They are development tooling, not part of the
application, and nothing here ships in a build.

| File | What it is |
|---|---|
| `preview.js` | the only supported way to start the preview |
| `make-preview-graph.js` | rebuilds the synthetic demonstration graph |

## Starting it

```
cd <your checkout>/development/f27-slice-1
node f27-preview/preview.js
```

`--reset` rebuilds the demonstration graph first. `--self-check` is a
maintenance mode: it performs the guided walkthrough automatically, writes a
result file and exits.

The user-facing walkthrough — what to click and what you should see — lives in
the project notes beside this checkout, not in this repository:
`project-notes/F27_USER_PREVIEW_GUIDE.md`.

## Where things are

Everything the preview generates is written **outside this repository**, so no
profile, graph or binary can be committed by accident:

- demonstration graph — `development/f27-preview/graph/f27-preview-demo`
- launch profiles — `development/f27-evidence/preview-<timestamp>`
- self-check results and screenshot — `development/f27-preview/`

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
- **Foreground only.** No background watcher, no auto-restart, no login item, no
  change to installed applications, user settings, network settings or global
  shortcuts. Closing the command closes the preview.
- **Bounded session.** The session closes itself after 12 minutes, the project's
  standing per-session bound. Running the command again starts a new one.
- **Read-only.** The launcher records a SHA-256 of the demonstration graph after
  the application's first-open housekeeping settles, and compares it again at
  shutdown, so the run reports whether any byte changed.

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
