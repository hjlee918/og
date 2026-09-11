# Approved isolated offline preview

User approved this limited preview after the compatibility report. Daily use,
installation, deployment, account access and profile migration are not approved.
The report's historical recommendation and all prior failures remain preserved.

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
pinned to build `2026-09-10T22-15-35-426Z-4cf82a57`, clean product source
`cb04131613e1640ca0e64c47e07b3afca81c47f6`. No rebuild or bundle modification.

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

Only the retained, verified Readwise artifact is installed in this fresh profile.
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

## Verified inspection session

Prepared September 10 LA / September 11 UTC; checked still open on resume.
Evidence: `../evidence/origin-preview-2026-09-11T03-48-17-210Z.json`.
The screenshot beside that JSON records the verified starting view.

- Status at handoff: intentionally open; supervisor PID **27278**, app PID **27340**.
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

한국어 상태: 승인된 격리 오프라인 미리보기를 의도적으로 열어 둡니다.
Readwise 가져오기·동기화는 사용할 수 없으며 일상 사용·배포 승인이 아닙니다.
종료 뒤에만 시험 프로필을 보존하고, 이번 실행에서 옮겨 둔 이전 프로필은 없습니다.

## Existing disposable Intel graph session — 2026-09-11

The user confirmed `LogseqOGINTELTEST` is an Intel-only disposable copy, separate
from their working graph and the Mac Studio test graph. No Roam JSON was supplied,
so import is not part of this session.

- Window: **INTEL DISPOSABLE GRAPH · 인텔 폐기용 그래프 · OFFLINE**.
- Exact LIVE graph: `/Users/johnlee/Library/Mobile Documents/com~apple~CloudDocs/Logseq Test/LogseqOGINTELTEST`, confirmed independently by both live application APIs before handoff.
- Profile: fresh `/Users/johnlee/Library/Application Support/Logseq OG F28 OriginExp/originexp-state`; no prior profile was displaced.
- Ownership at handoff: supervisor PID **29571**, app PID **29644** and four initially retained app processes. The supervisor has no timeout.
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

Use **Command-Q** to close safely. Only after the app exits will the supervisor
preserve the fresh profile as `originexp-state.offline-preview-2026-09-11T13-06-18-414Z`.
There is no displaced profile to restore. The graph itself is retained in place.

한국어: 이 창은 인텔 전용 폐기 가능한 복사본을 연 격리 오프라인 실험입니다.
Readwise 동기화·로그인·AI 요청은 사용하지 마세요. 이번 실행에는 승인된 Roam JSON
경로가 없으므로 가져오기를 시험하지 마세요. 종료는 **Command-Q**를 사용하세요.
