# Logseq OG F27 Pilot — build, package, validate

A second, clearly separate local Intel application that runs the accepted F27
renderer with its writable state and OS identity disjoint from the installed
Logseq OG. Local only: unsigned, never installed, never distributed.

Everything here is tracked source. The application directory it produces
(`static/`) and the packaged app (`../out/`) are build outputs and are not.

## Reproduce

```sh
# from the pilot clone's repo root, on branch pilot/f27-desktop-pilot
node f27-pilot/scripts/build-pilot.js       # main process only, PILOT=true
node f27-pilot/scripts/package-pilot.js     # electron-forge package, darwin/x64
node f27-pilot/scripts/run-tests.js         # 41 focused tests
node f27-pilot/checks/pilot-checks.js       # 41 packaged-application checks
```

Two supporting checks, slower and run on demand:

```sh
node f27-pilot/scripts/check-ordinary-build-unchanged.js   # ordinary build is byte-identical
node f27-pilot/scripts/build-nonpilot-reference.js         # reference bundle for guards.test.js
```

`build-pilot.js` refuses to run outside a pilot clone and off the pilot branch,
so it can never write into the accepted checkout. The renderer is never rebuilt:
`gulp:build` is not run (its `clean` deletes `./static/**/*`) and `:app` is not
compiled, so all 3220 accepted renderer artifacts pass through byte-identical —
which the script measures rather than assumes.

## Layout

| | |
|---|---|
| `src/pilot-main.js` | the packaged app's `main`; establishes identity and isolation before `require('./electron.js')` |
| `src/pilot-preflight.js` | reads the compiled bundle as bytes and verifies it against the manifest — never requires it |
| `src/pilot-isolation.js` | ownership-checked state root, symlink and containment rejection, full Electron path audit |
| `src/pilot-identity.js` | identity constants, hard-coded so a manifest cannot rename the app into this one |
| `src/pilot-forge.config.js` | packaging config: no protocols, no signing, no notarization, no publishers |
| `scripts/` | build, icon, packaging, tests, equivalence checks |
| `checks/` | packaged-application validation, OS footprint attribution, graph-data boundary |
| `tests/` | focused tests for every refusal path and ownership rule |

The four main-process guards live in `src/electron/electron/pilot.cljs` and are
applied in `core.cljs`, `updater.cljs` and `server.cljs`, all behind the closure
define `electron.pilot/PILOT`, which is `false` in every ordinary build.

## Graph data

The pilot intentionally disables publishing/export and recursive directory
copying, as well as upstream updates and API-server startup. These restrictions
are pilot-only. It is not a replacement for the installed everyday app.

Graph data is used only inside
`~/Library/Mobile Documents/com~apple~CloudDocs/Logseq Test`, enforced by
the application boundary and `checks/allowed-root.js`, with symlink and traversal
escape checks. Checks reuse the ownership-verified synthetic batch graph; they
do not need a new graph for every attempt. No
personal graph is opened, read or enumerated, and the installed application is
never launched.
