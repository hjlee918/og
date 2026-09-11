# Origin experiment checkpoint — 2026-09-10

**Not ready for live plugin activation or deployment.** This continues the
approved experiment; it does not start a new phase. Source repair commit
`7af0ce9a2bfecc8f6abf82926de9358e18b7e735` remains separately identifiable.
The upstream branch was verified at `d5a73f73a4c8c751a46016bc01c5d3c0d1210d28`
before the non-force push. Partial files and previous evidence are preserved.

## Package identity

The completed build was in `static/`; no experimental package existed at resume.
Forge packaging initially failed on sandbox DNS, then succeeded with network
access. There was no rebuild of application source and no duplicate build.

- Experimental app: `../out-originexp/Logseq-OG-F28-OriginExp-darwin-x64/Logseq-OG-F28-OriginExp.app`
- Build: `2026-09-10T20-58-54-326Z-cf6bcbfe`
- Bundle: `com.logseq.logseq-og.f28originexp` (also read from Info.plist)
- Manifest SHA-256: `5b099b31a7c9a4fc39476322969c3a576536e12bc37575a7b21e2b1cf4398c76`
- Recorded source: `7af0ce9a2bfecc8f6abf82926de9358e18b7e735`, dirty=true;
  renderer `7af0ce9a2-dirty`. This is preserved provenance, not a clean-build claim.
- Experimental package preflight: passes.
- Preserved RefPath package preflight: passes; build
  `2026-09-10T11-28-38-531Z-53b57083`, manifest SHA-256
  `3bff119b2449ed9121a1c74085be5cb60f0446780cff93ba381398ff4a111c0e`.
- Default package selection now excludes OriginExp; explicit selection is required.
- No existing profile was opened, moved, migrated or inspected by these checks.

## Activation safety finding and stop condition

The partial `network-refusal.js` installed after Playwright launch returned.
`electron.window/create-main-window!` constructs a BrowserWindow and calls
`loadURL` itself, so that order cannot prove interception before navigation.
Moreover `electron.handler` exposes `:httpRequest` and `:httpFetchJSON`, which
call `electron.utils/fetch` backed by `node-fetch`. A defaultSession hook is
not evidence of coverage for those main-process calls, other sessions, native
network paths, or external browser activation. Empty credentials are insufficient.

The plan's section 8 stop condition applies: no contained activation path has
been established. The experimental runner now refuses at the very beginning of
`main()`, before package resolution, profile swaps, seeding, graph creation or
launch. The injectable launch adapter independently refuses before calling
Playwright, so there is no post-launch installation failure that can strand a
process. The unsafe partial implementation is retained as non-executable
`checks/network-refusal-unaccepted.txt`, explicitly marked unaccepted.

No product/plugin launch occurred. Readwise genuinely loaded state and handshake,
Ollama/ChatGPT loading individually or together, actual product renderer origin,
plugin URLs, reference journey, Korean, keyboard, navigation, local assets,
runtime errors, blocked service attempts and graph integrity are **not measured
for this experimental package**. No zero-error, zero-request or graph-hash
acceptance is inferred from absence of a run. `[frontend.handler]` uncertainty
remains unresolved. The dormant runtime probes are preserved, not accepted as
executed evidence. No third-party bundle patch or Electron security relaxation
was made.

## Tests and explicit omissions

Combined final results, with only affected failures/checks rerun:
**430 passed, 0 unresolved failures, 9 skipped; 2 additional pilot identity
checks excluded by name.** This is not the earlier 424/424 result and is not one
single all-green invocation.

- Pilot regression: 74 passed. Its two built-directory identity checks remain
  excluded by the existing name filter (not counted by Node as skipped).
- F28: first run 254 passed, 2 Electron fixture launch failures, 9 skipped.
  Unmodified handshake suite rerun outside the sandbox: 3/3 passed, resolving
  those two failures. Effective F28 result: 256 passed, 9 skipped.
- Experiment: final affected suite 29/29 passed.
- Inherited F27 fixture/error tooling: 71/71 passed. Its historical build-specific
  suite remains excluded as before; it targets a different static identity.

The nine accepted-build skips map to active experimental assertions in
`tests/experiment-build.test.js`: build presence; main bundle hash and guard
closure define; every startup file's manifest hash; preflight and check count;
unchanged pilot guard bytes; full identity separation and shared boundary
contract; branch/revision/schema/renderer build provenance; renderer revision,
closure path and absent telemetry defines; packaging output, bundle identity,
no signing/notarization/protocol registration/makers/publishers. The two excluded
pilot properties are also covered by the active main-bundle and preflight checks.
The historical file-origin reproducer is unchanged. The new tests also cover
pre-launch refusal, refusal before profile work, explicit experimental selection,
and preservation of unknown storage keys.

## Synthetic settings and rollback findings

The prior fixture at `.../T/f28-origin-storage-2jVOID` contains both origin strings
in its storage files, but no saved result was found in project evidence. That
alone is not migration acceptance. A fresh fixture run now records:

- Four synthetic keys exist at `file://`; `lsp://logseq.com` initially sees none.
- Three synthetic preference keys copied to the new origin verify equal.
- A deliberately corrupted in-memory comparison is detected; this is not an
  injected browser-storage failure or interruption test.
- All four old-origin values remain intact afterwards.

The fixture now serves exactly one allow-listed lsp URL and installs request
refusal before creating its windows. It has no plugins or product IPC bridges;
its network control is **not** claimed as product coverage. It records
`acceptedAppRollback: false` explicitly. All temporary fixture profiles remain.

Preservation inventory is still a design/source inventory for the product:
UI preferences, unknown origin storage, config/config.edn, plugin settings,
preferences.json, configs.edn and window-state.json must be preserved. Graph
Markdown is authoritative and must not be migrated by this tooling. Search and
DB indexes are potentially rebuildable only after exact product stores/keys are
measured; broad name patterns cannot classify them safely. Classification now
recognizes only this fixture's explicit synthetic cache as rebuildable.

A future synthetic migration implementation must use a versioned key inventory,
validate graph-bearing state against the exact canonical allowed test graph,
refuse destination conflicts, journal original destination values durably,
verify writes, and write the completion marker last. Recovery must detect
intervening edits; blind retries are not idempotence. Test interruption after each
write, conflict, verification failure and marker failure before claiming recovery.
No such implementation or real-profile migration is delivered here.

Accepted-app rollback remains pending: after activation containment is established,
use only an explicitly owned disposable TEST profile and canonical test graph;
close owned experiment processes, verify the preserved accepted package identity,
then launch the old TEST build/profile and assert exact LIVE graph identity before
interactions. Retention of old-origin fixture values and accepted package preflight
are useful evidence but do not substitute for that launch.

## Boundary and cleanup

No Logseq app or plugin was launched; only synthetic Electron fixture applications
ran. No graph content was read or written by these checks. **Execution limitation:**
an initial `find .. -name AGENTS.md` instruction search was too broad and was
interrupted. It returned no paths, but out-of-scope metadata traversal before the
interrupt cannot be excluded. This prevents an unqualified no-metadata-access
claim. Later instruction searches were restricted to exact project paths.

Process inspection before work found no batch-owned app/build. Final inspection
found no experiment, fixture Electron, or packaging process. An unrelated Claude
crash handler was left untouched. No host networking setting was changed.

Evidence under `../evidence/`:
`f28-origin-package-resume[-network]-20260910.log`,
`f28-origin-package-identity-resume-20260910.json`,
`f28-origin-tests-resume-20260910.log`,
`f28-origin-handshake-retry-20260910.log`,
`f28-origin-affected-tests-final-20260910.log`,
`f28-origin-gate-recheck-20260910.log`,
`f28-origin-prior-storage-inspection-20260910.json`, and
`f28-origin-storage-resume-20260910.json`.

Return to supervisor review with live activation and accepted-app rollback blocked.
No merge, release, installation, deployment or real-profile migration is authorized
by this checkpoint.
