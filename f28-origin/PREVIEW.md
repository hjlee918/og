# Approved isolated offline preview

User approved this limited preview after the compatibility report. Daily use,
installation, deployment, account access and profile migration are not approved.
The report's historical recommendation and all prior failures remain preserved.

## Independent Intel test launcher

The current local launcher is:

`/Users/johnlee/LogseqOGRoam/development/f27-inline-context/out-launcher/Logseq OG Test — Offline.app`

Double-click it in Finder. Its bilingual folder picker starts in the canonical
`Logseq Test` root and accepts only an existing, canonically contained directory.
It rejects outside paths, relative paths and symlink escapes before graph-content
access. Cancellation makes no graph selection. The launcher never chooses or
creates a graph for the user, and existing-graph preparation does not inject
fixtures, overwrite graph settings or CSS, reset notes, or run an import.

The launcher uses the Intel experimental package, build
`2026-09-11T18-21-00-039Z-918adc55`, clean product source
`352b3ea7003e7c7c41b96fcc4271f5c88e841c71`, bundle
`com.logseq.logseq-og.f28originexp`, and startup control
`f28-origin-network/1`. The launcher bundle is
`com.logseq.logseq-og.test.offline-launcher`, architecture `x86_64`; it is a local
test artifact, not an installation or release. Its manifest is at
`Contents/Resources/launcher-manifest.json` inside the app.

The app keeps an ownership-marked, app-specific TEST profile between normal
launches so test preferences survive. It permits exactly the verified Readwise
artifact and pinned official Dracula theme, refuses retained credentials or
automatic Readwise loading, and does not install the optional AI plugins. A live lease refuses a
second overlapping launch. A crash leaves the lease in place and the next launch
fails closed with a bilingual recovery message; do not delete such a lease until
owned processes have been reviewed. There is no inspection timeout. Use
**Command-Q** to quit; profile state is retained only after every owned app process
has exited.

Roam/JSON/OPML import is unavailable in this launcher. Those existing importer
controls use Chromium renderer-native file inputs, which do not pass their chosen
path through the guarded main-process boundary. The launcher disables their input
clicks and explains the limitation instead of claiming containment. The user has
cancelled the previous dedicated Roam-import task: preserve OG's existing
importer and historical records, but do not design, implement or specially test
a replacement. The isolated launcher's refusal remains unchanged.

Graph-local `logseq/custom.css` continues to load normally. Official Dracula
`0.1.0` is installed locally from exact upstream commit
`0064af84b7236676f6b4b6d1b37c355501c91111` and selected through Logseq's own
theme API. The experimental `lsp:` renderer keeps that verified stylesheet on
guarded `assets:`; ordinary accepted/file-origin behavior is unchanged. Dracula's
Google Fonts `@import` and every other remote CSS request remain blocked. The
user's `custom.css` is not downloaded, rewritten or renamed.

Fresh synthetic-data verification passed 14/14 integration checks: LaunchServices
double-click and picker cancellation, valid selection and exact LIVE graph,
outside-root and symlink refusal, locally selected Dracula dark mode and
`#282a36` token, local graph CSS, disabled import inputs, unchanged
graph content, safe Quit, persistent-profile reuse, overlap refusal, lease cleanup
and post-exit profile preservation/restoration. Focused source/package/tooling
checks passed 30/30. The inherited
synthetic reference preview then passed 16/16 and closed with no retained app
process. The user's disposable sample graph was not used for automated mutation
tests. Evidence and generated profiles remain local and are not Git inputs.

From this checkout, repeatable launch:

```sh
node f28-origin/checks/preview.js start
```

For a user-confirmed existing disposable graph, use the explicit path mode. It
refuses relative paths, paths outside `Logseq Test`, symlinks and non-directories:

```sh
node f28-origin/checks/preview.js start-existing --graph "/exact/approved/path"
```

Existing mode does not generate, annotate, list, hash, screenshot or navigate the
graph's notes during preparation. It asserts the application's exact LIVE graph
identity before handoff. Normal application opening may create its ordinary local
state in the disposable graph, and the user may edit it during the preview.

Keep that terminal/supervisor running. There is no inspection timeout. Each launch
creates a unique synthetic graph and preserves the previous run; a live lease
refuses overlapping launches. Package identity, source and startup hashes are
pinned to build `2026-09-11T18-21-00-039Z-918adc55`, clean product source
`352b3ea7003e7c7c41b96fcc4271f5c88e841c71`.

Close from another terminal in this checkout:

```sh
node f28-origin/checks/preview.js close
```

Alternatively, focus **OFFLINE PREVIEW · 오프라인 미리보기 · Readwise** and press
**Command-Q**. The red window close button may only hide the window; use Quit or
the command above. The supervisor closes only its retained application handles,
checks that processes exited, preserves the new profile by rename, then restores
any ownership-verified displaced experimental test profile. It never restores
while an app process is running. It exits after cleanup. The accepted RefPath
profile is not involved.

`../evidence/origin-preview-active.json` names the supervisor PID, run evidence and
close-request path. The per-run JSON records the exact graph, profile, package,
owned app PIDs, checks, strict errors and final cleanup. If the supervisor crashes,
do not relaunch the package, remove the lease or manually restore a profile:
retain everything for an owned-process review. No unrecorded watcher is required.

The independent launcher installs only verified Readwise plus pinned official
Dracula; the older synthetic command mode remains Readwise-only.
Credentials are absent; `isLoadAuto:false` and `isResyncDeleted:false` are explicit
preview settings. Unchanged startup refusal blocks service requests, main bridges,
proxy and external opening. Readwise controls may still be visible, but import and
sync cannot operate. Do not enter credentials or invoke plugin service controls.
Ollama and ChatGPT are not installed. This is application containment, not an OS
sandbox or arbitrary-native-code protection.

Start at **기준 대상 Anchor Page**. All examples are synthetic English/Korean notes.

1. Read the offline notice, then scroll to **10 Linked References**.
   안내문을 읽고 아래 **10 Linked References**로 이동하세요.
2. Inspect **⋯** on a source breadcrumb and the row's **이 아래 내용 보기** (show child content) control.
   출처의 **⋯**와 **이 아래 내용 보기** 단추로 내용을 살펴보세요.
3. Compare the reference order choices if useful; return to the starting page
   using the app's back navigation after following a source.
   정렬 방식과 출처 이동을 살펴보고 앱의 뒤로 가기로 돌아오세요.
4. Finish with **Command-Q** or the close command above.
   끝나면 **Command-Q** 또는 위 종료 명령을 사용하세요.

The operator already checks actual Readwise loaded state/UI, exact LIVE graph,
reference groups, source-path and keyboard child disclosure, Korean labels,
navigation, local asset and content integrity before handoff. These are not user
retest assignments. Useful feedback: whether source paths provide enough context,
whether child disclosures feel cluttered, and which reference ordering feels most
natural. Readwise authenticated behavior remains untested; historical strict error
failures and metadata-traversal uncertainty are not erased by this preview.

Graph access remains limited to canonical owned subfolders of
`/Users/johnlee/Library/Mobile Documents/com~apple~CloudDocs/Logseq Test`.
Never open personal graphs, installed Logseq or personal profiles.

## Historical verified inspection session (closed)

Prepared September 10 LA / September 11 UTC and later closed.
Evidence: `../evidence/origin-preview-2026-09-11T03-48-17-210Z.json`.
The screenshot beside that JSON records the verified starting view.

- Status at the original handoff: intentionally open; supervisor PID **27278**,
  app PID **27340**. The later close retained the strict failure classification,
  exited all owned processes and restored/preserved only owned TEST profile state.
- Graph: `/Users/johnlee/Library/Mobile Documents/com~apple~CloudDocs/Logseq Test/f28-reforder-offline-readwise-preview-2026-09-11T03-49-04-817Z`.
- Profile: `/Users/johnlee/Library/Application Support/Logseq OG F28 OriginExp/originexp-state`.
- No profile was displaced. After exit the supervisor will preserve this profile
  as `originexp-state.offline-preview-2026-09-11T03-48-17-210Z`; there is no prior
  profile to restore for this run. Earlier profiles remain untouched.
- 16/16 targeted handoff checks passed: actual Readwise handshake/UI, empty
  credentials and auto-loading disabled, canonical LIVE graph, isolated profile,
  startup refusal, 8 groups/22 rows, keyboard/context/path controls, Korean,
  alias navigation, local asset and unchanged generated content/plugin bytes.
- Strict errors: **not all clear**. One startup `ERR_BLOCKED_BY_CLIENT` remains
  unexplained by the unchanged classifier; two deliberate negative-dialog errors
  were correlated as expected. No reference-journey error was captured.
- Tooling tests: 3/3. The earlier launch/close rehearsal passed 16 checks and
  exited with no owned processes remaining; its profile and evidence
  `origin-preview-2026-09-11T03-44-56-770Z.json` are preserved. The inspection
  uses the simpler existing reference-order fixture, avoiding cyclic stress
  examples; no product source or package changed.

한국어 상태: 승인된 격리 오프라인 미리보기 실행은 종료되었습니다.
Readwise 가져오기·동기화는 사용할 수 없으며 일상 사용·배포 승인이 아닙니다.
종료 뒤에만 시험 프로필을 보존하고, 이번 실행에서 옮겨 둔 이전 프로필은 없습니다.

## Intel feedback and Apple Silicon follow-up

The user reported “Everything looks good” for the Intel inspection and confirmed
closing it with Command-Q. Record that as positive UI/UX feedback for that
isolated preview only. It is not daily-use, deployment, synchronization,
authenticated-service or full-compatibility acceptance. This Apple host did not
independently verify cleanup of the Intel processes.

The bounded Apple Silicon equivalent completed on native arm64 and closed after
automation. All 17 targeted containment/UI checks passed, including actual
Readwise handshake and injected UI, 8 groups/22 rows, the three ordering modes,
stable child structure, Korean controls, keyboard/path disclosure, navigation,
local assets and content/plugin integrity. Strict error accounting still fails
on one unexplained startup `ERR_BLOCKED_BY_CLIENT`. Exact package and cleanup
details are in [APPLE_SILICON_READINESS.md](APPLE_SILICON_READINESS.md).

The Apple evidence remains bound to clean source `87b811663` and arm64 build
`2026-09-11T22-07-22-370Z-4750cad0`. It does not show that package contains the
later Intel Dracula/standalone-launcher work, and post-merge source tests are not
a substitute for a new arm64 runtime run. The Intel launcher and its pinned x64
package remain unchanged by the architecture-selection merge.

The Intel integration review fast-forwarded the feature branch through the
Apple merge without rebuilding either package. Fifty-eight focused non-launching
tests passed for architecture selection, experimental source/build provenance,
graph verdicts, cleanup ordering, launcher choices, error redaction and the
pinned local Dracula artifact. A new Intel smoke run and the real-Electron
bootstrap fixtures were deliberately not started while the user's owned Intel
preview was open. The retained Intel 14/14 launcher smoke evidence and exact x64
package remain the runtime basis; the unexplained startup
`ERR_BLOCKED_BY_CLIENT` remains a strict failure.

## Historical disposable Intel graph session — 2026-09-11 (closed)

The user confirmed `LogseqOGINTELTEST` is an Intel-only disposable copy, separate
from their working graph and the Mac Studio test graph. No Roam JSON was supplied,
so import is not part of this session.

- Window: **INTEL DISPOSABLE GRAPH · 인텔 폐기용 그래프 · OFFLINE**.
- Exact LIVE graph: `/Users/johnlee/Library/Mobile Documents/com~apple~CloudDocs/Logseq Test/LogseqOGINTELTEST`, confirmed independently by both live application APIs before handoff.
- Profile: fresh `/Users/johnlee/Library/Application Support/Logseq OG F28 OriginExp/originexp-state`; no prior profile was displaced.
- Ownership at the original handoff: supervisor PID **29571**, app PID **29644**
  and four initially retained app processes. The session later exited all owned
  processes; its strict failures remain recorded as `failed-closed`.
- 10/10 handoff checks passed: package guard, lexical outside-path refusal, both
  LIVE graph gates, isolated profile paths, startup control, Readwise-only
  handshake/loaded/UI, auto-import disabled/no credential, and final exact graph.
- Five network refusals were recorded by kind only. Strict error accounting remains
  failed: one blocked startup resource and one other runtime error were retained.
  The latter contains a disposable graph page title in this run's local evidence;
  that evidence is not committed or uploaded. Future existing-graph evidence
  redacts runtime text while retaining classification and SHA-256 identity.
- Preparation did not generate, annotate, list, hash, screenshot or navigate the
  graph's notes. After the LIVE assertion, the operator performed no scripted
  interaction. The user may edit this disposable copy. Roam import should not be
  attempted in this session because no approved JSON path was provided.

The session was closed safely. Only after the app exited did the supervisor
preserve its fresh TEST profile. There was no displaced profile to restore. The
graph itself remained in place.

한국어: 이 창은 인텔 전용 폐기 가능한 복사본을 연 격리 오프라인 실험입니다.
Readwise 동기화·로그인·AI 요청은 사용하지 마세요. 이번 실행에는 승인된 Roam JSON
경로가 없으므로 가져오기를 시험하지 마세요. 종료는 **Command-Q**를 사용하세요.
