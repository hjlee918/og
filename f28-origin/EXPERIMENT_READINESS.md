# Isolated origin experiment — supervisor review

Updated 2026-09-11 (Los Angeles; run evidence uses UTC timestamps).
The approved experiment now has a tested startup control and actual plugin
activation evidence. It remains experimental and inactive in the accepted build.
This is not deployment or general plugin compatibility acceptance.

## Package and source

- Package: `../out-originexp/Logseq-OG-F28-OriginExp-darwin-x64/Logseq-OG-F28-OriginExp.app`
- Build: `2026-09-11T18-21-00-039Z-918adc55`; bundle `com.logseq.logseq-og.f28originexp`.
- Clean source: `352b3ea7003e7c7c41b96fcc4271f5c88e841c71`; renderer `352b3ea70`.
- Manifest SHA-256: `2df86456ce068cdeb4725c5e4a0984a5cae23c559f5242175819f84efb8a1d8d`.
  All 15 package preflight checks pass, including bootstrap and preload hashes.
- Accepted RefPath package remains build `2026-09-10T11-28-38-531Z-53b57083`,
  manifest `3bff119b2449ed9121a1c74085be5cb60f0446780cff93ba381398ff4a111c0e`.
- Original experiment is preserved in `../out-originexp-preserved-20260910-cf6bcbfe/`:
  build `2026-09-10T20-58-54-326Z-cf6bcbfe`, source `7af0ce9a2-dirty`, dirty=true,
  manifest `5b099b31a7c9a4fc39476322969c3a576536e12bc37575a7b21e2b1cf4398c76`.
- The earlier clean bootstrap package is also preserved in
  `../out-originexp-preserved-20260910-c886eac2/`. Its live evidence predates
  explicit native proxy/PAC refusal and is not substituted for final-package evidence.
- The immediately preceding package is preserved at
  `../out-originexp-preserved-20260911-1821-pre-dracula/`: build
  `2026-09-10T22-15-35-426Z-4cf82a57`, clean source
  `cb04131613e1640ca0e64c47e07b3afca81c47f6`. A failed packaging output is
  separately retained and is not a runnable-package claim.

## Offline Dracula compatibility

The independent Intel launcher installs exact, unmodified files from official
`dracula/logseq` commit `0064af84b7236676f6b4b6d1b37c355501c91111`
(manifest `2e3b6095...6981d`, CSS `3ba529d4...6260c`) into only its owned TEST
profile. Dracula and Readwise both report genuinely loaded. Logseq selects
Dracula in dark mode, the stylesheet stays on guarded `assets:`, and the observed
root token is `#282a36`; graph-local `custom.css` also remains loaded. Integration
is 14/14 with repeat launch, content integrity, overlap refusal and post-exit
profile restoration. The theme's remote Google Fonts import remains refused.
Strict error accounting therefore remains failed for blocked-resource entries;
no classifier was widened. The accepted build, personal profile and user CSS are
unchanged.

## Containment and tests

[Network control scope](NETWORK_CONTROL.md) records the experiment-only first-party
bootstrap. It installs before the application bundle, first window, navigation or
plugin activation. It covers actual Chromium sessions; main HTTP bridges and their
node-fetch path; Node/Electron networking; native proxy resolution/configuration;
external opening, child processes and reviewed service/CLI/update paths. Existing
canonical local application/plugin/asset and graph guards remain enforced.
Incomplete installation exits before activation. Evidence is bounded to 100 fixed
refusal kinds without request URLs, headers, bodies or credentials.

This is application-level containment of reviewed activation paths, not an OS
sandbox or coverage of arbitrary native code. No wildcard origin, webSecurity
relaxation, third-party bundle patch or host networking change was used.

Final regression: **434 passed, 0 failed, 9 skipped**, with **2 additional pilot
identity checks excluded by name**. Breakdown: pilot 74; F28 256 plus 9 skips;
experiment 33; inherited F27 fixture/error tooling 71. The skipped accepted-build
identity assertions and two excluded pilot properties have active experimental
counterparts. Historical build-specific F27 checks remain outside this invocation.

Real Electron synthetic preactivation probes: **3/3 passed**, including failure
before main installation and failure during session installation. They prove
controls precede navigation, default and additional sessions refuse service
requests, main node-fetch/IPC/native proxy and built preload paths refuse requests,
local lsp resources work, and failed installation exits without activation.
Draft test/build failures and their corrected reruns remain in evidence; this is
not a claim that every invocation passed. An early lingering owned fixture process
was identified and stopped; final cleanup is checked separately.

## Actual plugin loading and reference checks

Each activation used verified retained plugin bytes, fresh isolated profiles,
explicitly empty settings, fresh canonical synthetic graphs, and exact LIVE graph
identity assertions before interactions. Registration alone was not accepted.

- Readwise v1.4.11: completed handshake, host loaded state and actual injected UI.
  The final full reference journey passed: 10 mentions, 8 groups, 22 rows; Korean
  labels, keyboard disclosure, navigation and local asset loading. **53/54 checks**;
  the strict window-error accounting check failed (9 unexplained captured errors,
  including blocked resources/negative protocol probes; 0 feature-phase errors).
- Ollama v1.1.6: completed handshake and injected one UI node, but startup throws
  `TypeError` during shortcut registration (`undefined.replace`) and reports the
  missing `ollama-logseq-config` page. This is partial initialization, not clean
  functional acceptance.
- ChatGPT v2.0.3: completed host handshake/loaded report, but zero injected UI and
  a callback cross-origin `SecurityError` assigning `Window.ChatGPT` from
  `lsp://logseq.io`. Actual initialization failed despite the host loaded flag.
- Combined: 3/3 host handshakes, two injected UI nodes, both plugin failures above.
  Individual Ollama/ChatGPT and combined loading checks total **90/93**. All three
  failures are strict error accounting (12/9/12 unexplained errors respectively).
  These runs deliberately skip the reference journey.
- No OAuth, account access, credentials, import/sync or AI commands were requested.
  Plugins can attempt automatic startup work: Readwise wrote `lastSyncFailed:true`
  into its preserved settings. Remote/loopback requests are refused; no successful
  import/sync or service feature is claimed. Other-plugin reference journeys are explicitly skipped (`--load-only`).
  There is no claim that service features work under refusal.

Every final live session retained unchanged graph content and plugin package
bytes, with only three expected housekeeping additions (`.DS_Store`,
`logseq/custom.css`, `pages/contents.md`). Each session reports zero surviving owned
processes. Refusal counts were Readwise 6, Ollama 6, ChatGPT 4 and combined 4,
including three native proxy refusal records in each session. They are bounded
application evidence, not packet capture or an OS-wide network claim.

The strict error classifier was not relaxed. Earlier `[frontend.handler]`
uncertainty remains unresolved even when absent in these runs.

## Storage, rollback and preservation

Actual lsp storage inventory records eight key names/lengths and IndexedDB names
`localforage`, `logseq`, `logseq-test-db-foo-bar-baz`, without values. The actual
observed graph-bearing key is `current-repo`; fixture `git/current-repo` must not
be assumed to describe product storage. Unknown stores, settings and preferences
are preserved, not classified as disposable. Session settings/prefs are renamed
aside and retained. Plugin bundle hashes remain unchanged.

The earlier synthetic storage fixture (`f28-origin-storage-resume-20260910.json`)
proved new-origin isolation, copying three synthetic preferences, preservation of
four old values and detection of an in-memory mismatch. It did not prove durable
migration, interrupted-write recovery or actual app rollback. Its
`acceptedAppRollback:false` remains accurate. No production migration/recovery
implementation or user-profile migration was performed.

**Actual old TEST package rollback passed on the final package.** The preserved
RefPath package opened a fresh TEST profile and synthetic graph; the experimental
package used a separate fresh profile; the same old TEST profile then reopened.
The old synthetic preference was absent in the candidate and remained unchanged
on return. Exact LIVE graph identity passed before interactions; all eight
reference groups were present before and after; graph content stayed unchanged
(three expected housekeeping additions). All three stages exited with no owned
processes left. This demonstrates actual package rollback, distinct from the
storage fixture, and does not migrate a profile.
The accepted shared profile was preserved by ownership-checked rename and restored
with the original `2026-09-09T04:06:07.447Z` marker,
not launched or migrated. All run profiles and prior evidence are retained.

## Boundary and retained uncertainty

Graph content access was confined to canonical test-owned subfolders of
`/Users/johnlee/Library/Mobile Documents/com~apple~CloudDocs/Logseq Test`.
No personal graph investigation was performed to resolve historical uncertainty.
The prior interrupted broad instruction search could have traversed out-of-scope
metadata; that uncertainty remains. An inherited assertion in the first resumed
live run checked existence of an explicitly nonexistent inert sibling probe path;
it was removed, and final negative-path assertions perform lexical checks only.
Neither point supports an unqualified historical no-metadata-access claim.

No installation, default merge, release, deployment, accepted-build activation
change or real-profile migration is authorized by these results. Return for
supervisor review with compatibility and strict runtime-error failures retained.
The earlier blocked checkpoint is preserved in
[CHECKPOINT_BEFORE_BOOTSTRAP.md](CHECKPOINT_BEFORE_BOOTSTRAP.md).

## Final evidence

Local evidence is retained under `../evidence/`:
- `f28-origin-final-package-identity-20260910.json`
- `f28-origin-final-regression-20260910.log`
- `f28-origin-final-preactivation-tests-20260910.log`
- `f28-origin-final-readwise-20260910.log` and `f28-origin-experiment-1789094584478.json`
- `f28-origin-final-plugin-loading-20260910.log` and `f28-origin-experiment-1789094873779.json`
- `f28-origin-final-test-build-rollback-20260910.log` and `f28-origin-test-build-rollback-1789094915454.json`
- `f28-origin-final-preservation-20260910.json`

Final process inspection found no matching owned RefPath/OriginExp application,
workspace Electron fixture or build process. [RESULTS.json](RESULTS.json) contains
a compact source-controlled summary; raw evidence and prior failed runs remain
local and preserved.

## 한국어 진행 요약

실험 전용 시작 차단을 먼저 검증한 뒤 실제 플러그인을 실행했습니다.
Readwise는 악수·UI 생성과 참조/한국어/키보드/이동/로컬 자산 검사를 통과했습니다.
Ollama는 UI가 생기지만 초기화 오류가 있고, ChatGPT는 악수 뒤 창 출처 오류로
초기화가 실패합니다. 엄격한 오류 집계 실패는 그대로 남깁니다.
자동 회귀 검사는 434개 통과·9개 건너뜀·pilot 2개 별도 제외입니다.
기존 TEST 패키지로 실제 복귀해 설정과 참조 8그룹 보존을 확인했습니다.
시험 그래프 내용 변경과 남은 소유 프로세스는 없습니다. 기존 패키지·설정·프로필과
과거 메타데이터 탐색 불확실성을 보존하며, 설치·배포·실제 프로필 이전 없이 감독
검토로 반환합니다.
