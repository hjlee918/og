# Origin experiment: compatibility decision

Source/evidence review only. Verified clean `feature/f28-reference-paths` at
`ebae69a857fe66928b0a27ecbc1e8a09ec13d835` before this documentation update.
Package `2026-09-10T22-15-35-426Z-4cf82a57` remains built from clean `cb0413161`.

**Recommendation:** keep the architecture experimental and offer, subject to
supervisor/user approval, a limited offline Readwise-only preview. Do not require
optional AI plugins to be fixed first. Do not adopt this for daily use yet.

**Demonstrated benefits and blockers.** Readwise v1.4.11 completed the handshake,
reported loaded and injected UI. Its reference journey, Korean labels, keyboard,
navigation and local assets passed, with zero feature-phase errors. **53/54** is
still a failed overall run: strict window-error accounting retained nine entries.
Six refusals (three proxy, three Chromium) do not identify every service.
Startup `ERR_BLOCKED_BY_CLIENT` and preserved `lastSyncFailed:true` do not prove
authenticated sync. Import, repeat sync and reconciliation remain untested.

Ollama v1.1.6 created UI but initialized only partially. Its exact call is
`registerCommandShortcut({binding: logseq.settings.shortcut}, Ic)`; the failing
binding is **undefined**, reaching bundled SDK `G → $l → li → replace`.
The declared default is `mod+shift+o`, not the offending string. The fixture supplied `{}`. The plugin registers its schema inside the ready
callback and immediately renders; its bundled SDK sends the schema without
synchronously merging defaults there. This supports a settings-ordering failure;
later persisted defaults do not establish availability at the failing call.
Separately, `getPageBlocksTree("ollama-logseq-config")` returns null and the plugin
calls `forEach`. That absent fixture page supplies custom menu blocks using
`ollama-context-menu-title` and `ollama-prompt-prefix` properties. These plugin assumptions are exposed by fixture setup, not demonstrated
reference-code or network-refusal defects. Origin-related timing contribution is
unproven. A targeted future remedy could preconfigure the fixture and investigate
first-party settings delivery; a host SDK update cannot replace the bundled SDK.

ChatGPT v2.0.3 completes the host handshake but fails actual initialization before
UI creation. `main` begins `window.parent.ChatGPT = {}`. It uses that namespace for dialog callbacks, parent DOM, keyboard handlers
and command UI. Our app origin `lsp://logseq.com` and
plugin origin `lsp://logseq.io` are distinct: the initial assignment throws
`SecurityError` before settings and injectors initialize. This conflicts with the experimental architecture independently of service refusal. Historically `effect:true` bypassed the plugin-resource lsp
rewrite, retaining file URLs and the legacy environment such plugins relied on.
That flag did not override same-origin policy; earlier failed handshakes
do not demonstrate working parent privileges. A narrow first-party message API could support an adapted plugin, not these
unchanged direct accesses. Restoring privileges needs separate security analysis
and explicit approval; it is not recommended.

**Retained strict errors, without classifier changes.** R/O/C/A below mean final
Readwise/Ollama/ChatGPT/combined sessions; numbers are retained event sequences.

| Entries | Source/evidence classification |
| --- | --- |
| R0, O3 | Startup blocked resource; control effect consistent, exact initiator/URL unknown. |
| R3, O6, C3, A6 | Blocked resource during probes; consistent with deliberate unknown-host refusal, not conclusively request-correlated. |
| R4–6, O7–9, C4–6, A7–9 | Three file-not-found entries per session; consistent with the three app-host traversal/absolute-path probes. Individual URL attribution remains unproven. |
| R7/9, O10/12, C7/9, A10/12 | CORS messages explicitly name the plugin-host traversal target: deliberate harness probes, not AI service calls. |
| R8/10, O11/13, C8/10, A11/13 | Adjacent generic fetch failures likely accompany those CORS probes; no same-request correlation proves pairing. |
| O0/1, A1/2 | Shortcut TypeError reported twice; same stack, not proof of two independent defects. |
| O2, A3 | Missing configuration page/null iteration. |
| C0, A0 | Cross-origin parent assignment failure. |

Totals remain 9/12/9/12 unexplained by the strict classifier; narrative attribution
is not an exemption. The two separately correlated negative-dialog errors per
session were already expected. Historical `[frontend.handler]` uncertainty remains.

**Options and smallest next step.** Retain the experiment as evidence only; permit
a restricted offline preview; or consider adoption later after service/storage
work. Recommend the second: approve a short preview using the existing identified
package, Readwise only, empty credentials, unchanged startup refusal, a fresh
isolated profile and canonical synthetic graph under `Logseq Test`, with exact
LIVE graph assertion before interaction. Preserve the run and close only owned processes. No AI repair or broad
validation cycle is prerequisite. Nothing launches now.

**Daily Readwise use, security and rollback.** Daily use separately needs an
approved service-access design replacing unconditional refusal only for reviewed
necessary paths, authorized authenticated sync/import tests with synthetic data,
repeat/error/restart and data-integrity checks, and a decision on adopting the
origin change. Existing-profile use additionally needs explicit storage inventory,
conflict-safe migration, durable interruption recovery and rollback after changed
settings/data. Preserve unknown storage and settings; never reset them as caches.
Containment is application-level, not an OS sandbox or arbitrary-native-code protection.

The actual old TEST-profile round trip proved the old synthetic preference and
eight reference groups survived candidate use on a **separate** profile, with
unchanged generated graph content, three housekeeping additions and clean process
exit. It did not test migrating an existing profile, old-app interpretation of
new settings, synced/edited data, schema downgrade or restoring after those changes.
Switching packages cannot undo graph writes. The earlier storage-copy fixture is
also not durable recovery evidence.

**Decision requested:** approve only the restricted preview, or retain evidence
without a preview. Daily use, privilege changes and deployment remain unapproved.
No graph access, app launch, new tests, downloads, account access or migration was
performed for this report. Prior evidence and metadata-traversal uncertainty remain.

Sources: [readiness/evidence index](EXPERIMENT_READINESS.md),
[control scope](NETWORK_CONTROL.md), `libs/src/LSPlugin.core.ts`,
`LSPlugin.user.ts`, `f28-origin/checks/experiment-assertions.js`, and retained V5
`plugin-all` Ollama `index-a10eff10.js` / ChatGPT `index-304438df.js` bundles.
Event sequences above refer to final evidence IDs `1789094584478` / `1789094873779`;
rollback evidence ID `1789094915454`.
