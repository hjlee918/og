# Apple Silicon isolated offline preview

Recorded 2026-09-11 PDT. This is a bounded Apple Silicon equivalent of the
approved Intel offline preview. It is experimental evidence only, not daily-use,
deployment, synchronization, service, migration or general compatibility
acceptance.

## Scope and prior feedback

The user reported “Everything looks good” after the Intel isolated preview and
confirmed closing it with Command-Q. This is positive feedback on that preview's
UI/UX only. This Apple host did not independently verify Intel process cleanup,
and the feedback does not approve daily use, deployment, synchronization,
authenticated Readwise behavior or full compatibility.

No live-test or readiness coordination with Intel occurred. No installed Logseq
application or normal profile was launched. Graph access was limited to a newly
generated canonical child of
`/Users/johnlee/Library/Mobile Documents/com~apple~CloudDocs/Logseq Test`.

The referenced `project-notes/DATA_ACCESS_GUARDRAIL.md` was not present in the
Apple session's local project container or tested source checkpoint. The
enforced boundary in `f27-pilot/checks/allowed-root.js`, the F28 records and the
task's explicit guardrails supplied that run's fail-closed contract; this
historical absence remains disclosed. The later Intel integration adds a
portable tracked copy for future sessions. That documentation change does not
retroactively alter the package or evidence described here.

## Exact package identity

- Host/runtime: native `arm64` on Darwin 25.6.0; Node v22.23.2; Clojure CLI
  1.11.1.1413; Temurin JDK 17.0.20.1; Electron 41.7.1.
- Intel checkpoint received: `1eb5a5ce3175c45fb06d2d474d2782f0b71917b2`.
- Clean package source: `87b811663a298cb5a6ae4d4f73836a9ebc45a2a9`,
  the checkpoint plus native macOS architecture selection in packaging and
  packaged-app resolution. `builtFrom.dirty` is false.
- Build: `2026-09-11T22-07-22-370Z-4750cad0`.
- Identity: product `Logseq OG F28 OriginExp`; package
  `logseq-og-f28-originexp`; bundle `com.logseq.logseq-og.f28originexp`.
- Package: `../out-originexp/Logseq-OG-F28-OriginExp-darwin-arm64/Logseq-OG-F28-OriginExp.app`.
- Build-manifest SHA-256:
  `8a3e818e851f7d3f6cce05cfb922198c5a7fe51f8d00a0cab784e5bd9d30dc23`.
- Main executable SHA-256:
  `afa086d829713c1385c6f15999898a8b959af24abb46df949ac324047afc30a7`.
- The main executable is Mach-O arm64. Every packaged `.node` module contains
  arm64 code; `iconv-corefoundation` and `fsevents` are universal binaries and
  the remaining measured native modules are arm64-only.
- Both experimental closure defines are active, renderer assets are local,
  telemetry defines are absent, and the package's 15-check startup preflight
  passes. It is unsigned, unnotarized and local only.

The source tree's space-containing ancestor reproduced the known
`electron-deeplink` node-gyp failure. The successful build used a fresh
no-hardlink checkout at `/private/tmp/f28-arm64-build.A4sPT0/source`, at the exact
clean commit above. The resulting package was copied into this project's
preserved `out-originexp` directory. Failed dependency/rebuild/package attempts
were not substituted for the final package.

## Readwise artifact and runtime result

Only Readwise Official Plugin v1.4.11 was used. Its public release ZIP came from
the official Readwise GitHub release and has SHA-256
`807047fe8c8ea1d8d08483d55f8cca54dff2706d0148fd854dc1967b7f5b653f`.
Replaying Logseq's documented install-time manifest metadata produced the exact
retained package: 7 files, 332236 bytes, manifest SHA-256
`327ec6c51bd8dad080b1a2530d5a676a861cca22f203779f4118d8a41e44b97e`
and tree SHA-256
`4ca2768a6b4bf97a2fd0cc2757f068fbc962d6b3f337f785cffecfbab4e245fa`.

The final bounded run passed all 17 targeted checks. It established exact LIVE
graph identity before feature interaction; isolated userData/sessionData;
active startup refusal; the actual Readwise handshake, host loaded state and one
injected UI node; empty credentials with `isLoadAuto:false` and
`isResyncDeleted:false`; 8 reference groups and 22 rows; exact ascending,
descending and original-restored group ordering; unchanged rows, nesting and
breadcrumbs within every group; keyboard child disclosure; source-path
disclosure; Korean labels; alias navigation; local asset loading; unchanged
generated content; and unchanged plugin bytes.

Startup refusal recorded five events: proxy configuration, proxy reload, proxy
resolution and two Chromium requests. No OAuth, account access, import, sync, AI
request or plugin service control was exercised. A loaded flag alone was not
used: handshake state and injected UI were both required.

Strict error accounting remains **failed**. One startup
`ERR_BLOCKED_BY_CLIENT` is still unexplained by the unchanged classifier. The
two negative-dialog errors were correlated to the deliberate containment probe,
and no reference-journey error was captured. Historical compatibility and
strict-error limitations remain in force.

Final evidence is
`../evidence/origin-preview-2026-09-11T22-18-37-496Z.json`. Two earlier runs,
`...T22-12-56-304Z.json` and `...T22-15-51-320Z.json`, failed closed because a
new harness assertion compared object key insertion order while intentionally
reordering groups. The corrected check uses the repository's reviewed
group-by-group comparison. Both failed runs and their profiles remain preserved.

This runtime evidence is tied only to source
`87b811663a298cb5a6ae4d4f73836a9ebc45a2a9` and the exact arm64 package above.
That package predates the later Intel local-Dracula and standalone-launcher
changes. Merging the source and passing post-merge unit tests do not establish
post-merge arm64 runtime behavior.

The final synthetic graph is
`f28-reforder-offline-readwise-preview-2026-09-11T22-19-23-455Z` under the
approved root. Generated content stayed byte-identical; only expected
`logseq/custom.css` and `pages/contents.md` housekeeping files were added. The
fresh experimental profile was preserved as
`originexp-state.offline-preview-2026-09-11T22-18-37-496Z`. The application
closed, the lease was removed, and an executable-path check found no owned
package processes remaining.

Relevant source/tooling checks passed, including the three real-Electron
preactivation controls (3/3). A wider 72-test invocation produced 67 passes,
three sandbox-blocked Electron fixtures that passed when rerun with GUI process
permission, and two inapplicable assumptions: an accepted RefPath package on
this fresh host and retained Ollama/ChatGPT packages outside this Readwise-only
scope. Those two assumptions were not weakened or marked as passes.

## 한국어 로드맵 현재 상태

Apple Silicon용 격리 오프라인 미리보기는 네이티브 arm64 패키지에서 완료되었고,
Readwise 악수·실제 UI·참조 개요·경로·하위 내용·정렬·한영 표시·키보드·이동·로컬
자산·무결성·종료 검사를 통과했습니다. 다만 시작 단계의 설명되지 않은
`ERR_BLOCKED_BY_CLIENT` 1건이 남아 있어 엄격 오류 기준은 실패 상태입니다.
따라서 현재 단계는 제한된 오프라인 UI/UX 검증이며, 다음 단계인 인증 서비스
설계·가져오기/반복 동기화·충돌/재시작·프로필 마이그레이션/롤백·일상 사용 및
배포 승인은 아직 진행하거나 승인하지 않았습니다.
