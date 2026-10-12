# 자체 감사 보고 — 프로젝트(런처·도구·메타데이터·시험) · 2026-10-12

- 대상: `design/gui-redesign-proposal` 브랜치 (0.3.71 표기). 플러그인 본문(`PROGRAM/plugins/*.js`)은 **수정하지 않았습니다**.
- 방법:
  - 런처·업데이터·메타데이터·문서 정적 감사
  - 읽기 전용 도구 실행
  - `run_regression_batch.py`로 회귀 1,135개 실행 (장시간 3개 제외, 아래 참조)
- 환경: Node v22.23.3, 네트워크 없음. 그래서 `node_modules`(jsdom·acorn·terser)와 브라우저 실행 파일이 없습니다.

## 1. 회귀 결과

| 구분 | 수 |
|---|---|
| 실행 | 1,135 (제외: `libra_phase_d_timeline_caps`, `libra_phase_d_candidate_context_scale`, `libra_main_memory_letter_lifecycle_105turn` — 각 14~55분) |
| PASS / PASS_SKIP | 1,069 / 2 |
| FAIL | 64 → 이번 수정으로 2개 해소 |

FAIL 원인 분류:

| 원인 | 수 | 판정 |
|---|---|---|
| `jsdom`/`acorn`/`terser` 미설치 (GRADIA·release smoke 내부 포함) | 약 52 | 환경 |
| 브라우저 실행 파일 없음 | 4 | 환경 |
| 외부 증거 디렉터리 필요 (`FLASHBACK_SERVER_INSPECTION_ARTIFACTS`, external evidence dir) | 2 | 환경 |
| 저장소에 없는 과거 커밋을 고정 기준으로 요구 (`hayaku_canonical_builtin_access_runtime`) | 1 | 환경(얕은 이력) |
| IPv6 루프백 없음 (`loopback_host_compatibility`) | 1 | 환경 |
| root 사용자 홈 경로 (`source_tree_portability_scanner`) | 1 | 환경 |
| 시험 래퍼의 `NODE_OPTIONS` 가드 전제 (`namespace_reset_physical_admission`) | 1 | 실행 방식 |
| **Node 22에서 SQLite 경고가 자식 stderr를 오염** (`authority_crash_recovery` #14) | 1 | **결함 → 수정** |
| **Node 22에서 `node:sqlite`를 외부 의존으로 오판** (`distribution_runtime_dependency_closure`) | 1 | **결함 → 수정** |
| `namespace_reset_all5_composition`: RETRACE.js 고정 해시가 현재 소스와 다름 | 1 | **확인 필요 (아래 4)** |

## 2. 수정한 결함

| ID | 결함 | 수정 | 확인 |
|---|---|---|---|
| F01 (P0) | 루트 `업데이트.bat`만 LF 줄바꿈이고 `chcp 65001`이 없음 → 한국어 Windows에서 메뉴가 깨지고, cmd 라벨 탐색이 불안정할 위험 | CRLF + `chcp 65001` | 계약 시험을 루트·UPDATER까지 확장(CRLF·한국어면 chcp). 이전 파일로 되돌리면 실패하는지 확인함. 빌더 `assertRootUpdateLaunchers`도 `.bat` CRLF 강제(LF 입력 시 `distribution_update_launcher_must_use_crlf`) |
| F08 | `업데이트.bat` 2번 메뉴에서 빈 입력 시 따옴표 처리 | 빈 입력이면 안내 후 메뉴로 | — |
| F07 | `기존_DATA_이관_ZIP_만들기.bat`: 코드페이지, 끌어다 놓은 경로의 따옴표, Node 없음·빈 입력 때 창이 바로 닫힘 | `chcp 65001`, 따옴표 제거, 실패·빈 입력 시 `pause` | — |
| F10 | 관리도구 복원 bat 3종: 기존 환경변수(`TARGET` 등)가 입력값으로 섞임, 빈 입력 시 창이 바로 닫힘 | 입력 전 변수 초기화, 안내 후 `pause` | `windows_bootstrap_contract_test` PASS |
| F05 | `관리도구/전체_자동시험`이 시험이 아닌 helper 40개까지 실행 → 항상 실패. 그중 하나는 제품 플러그인을 직접 덮어쓰는 변형 도구 | `*_test.cjs`, `*.test.cjs`만 실행 (`run_regression_batch.py`와 같은 기준) | `cross_platform_launcher_test` PASS |
| F06 | 배포 문서 목록에 없는 파일(`PORTABLE_BACKUP_USAGE.md`)이 있고, `처음_읽어주세요.txt`가 가리키는 `STORAGE_MODE_TRANSITION_CONTRACT.md`가 빠짐 | 목록 정정 | `shouldCopyRuntimeProgram` 확인 |
| R1 | `verify_runtime_archive.cjs`: Node 22의 `builtinModules`에 없는 `node:sqlite`를 외부 의존으로 판정 → 지원 런타임(22.13~)에서 배포 검증 실패 | `node:` 요청은 `Module.isBuiltin`으로 다시 판정 | `distribution_runtime_dependency_closure_test` PASS |
| R2 | `authority_sqlite_fixture`: 자식 프로세스의 SQLite ExperimentalWarning이 stderr 비교를 깨뜨림 (Node 22) | 자식에 `--disable-warning=ExperimentalWarning` (제품 실행기의 `--no-warnings`와 같은 조건) | `authority_crash_recovery.test` PASS |
| F12 | `run_regression_batch.py`: 헤더에 GRADIA 누락, POSIX에서 자식이 stdin 상속, Ctrl-C 때 시험이 띄운 서버가 남음 | GRADIA 추가, `stdin=DEVNULL`, 인터럽트 시 프로세스 그룹 정리 | `regression_skip_detection_test` PASS |
| F11 | `_common.cmd` 안내 "Node.js 22 이상" (실제 22.13 이상) | 문구 정정 | — |
| F13 | `SHA256SUMS.txt`·`program-manifest.json`이 `docs/gui-redesign/**` 12개를 포함하지 않음 | `tools/update_manifest.cjs` → `tools/update_checksums.cjs --distribution`으로 재생성 | `sha256sum -c` 전수 OK, manifest·checksum·builder 관련 시험 26개 중 acorn 필요 1개 외 PASS |
| F17 | `tools/install_runtime.ps1` 줄바꿈 혼용 | CRLF로 통일 | — |

## 3. 수정하지 않은 것 (소유자 결정 필요)

- **F02 버전**: 공개 stable 릴리스·태그 `0.3.71` 이후 커밋이 139개입니다. 그 사이 World Manager 제거, 서버·플러그인 변경이 있었지만 VERSION·플러그인 `@version`·SDK 버전은 같습니다. updater는 높은 버전만 업데이트로 알리므로, 다음 배포 전에 버전을 올려야 합니다.
- **F03 공개 릴리스 자격**: 태그 시점의 `update-manifest.json`은 `offline_candidate`/`updaterEligible:false`입니다. 공개 ZIP이 같은 값이면 updater 검증에서 거부됩니다. 이 환경에서는 ZIP을 받을 수 없어 직접 확인하지 못했습니다.
- **F04 `PUBLICATION-PROVENANCE.json`**: 행 수·포함 범위·"코드 미수정" 진술이 현재 트리와 맞지 않습니다. 게시자 기록이라 손대지 않았습니다.
- **F14** tag 표기(`v0.3.71` vs `0.3.71`), **F15** 문서 링크 7개 깨짐, **F16** 안내 텍스트 3종 차이, **F09** `_server_foreground.cmd` 진단 경로·임시 로그, **F11** POSIX 런처의 PATH node 대체 경로 없음.
- `audit_flashback_manifest_locks.cjs`: 잠금 밖 저장 호출 11건이 보고됩니다. 플러그인 내부라 범위 밖이며, 의도된 예외인지 판단이 필요합니다.

## 4. 확인이 필요한 시험 고정값

`tests/fixtures/retrace_all5_reset_fixture.cjs`는 `plugins/RETRACE.js`의 SHA-256을 `366fcfab…`로 고정합니다. 이 값은 저장소 이력의 어느 RETRACE.js와도 일치하지 않습니다. `docs/regression/FIX39_PROCESSING_20261011.json`도 같은 값을 "missingSourcePins"(누락 커밋 `38946c7…`)로 기록하고 있습니다. 따라서 이 시험은 현재 저장소 어디에서 실행해도 실패합니다. 고정값을 다시 정할지, 시험을 "외부 차단"으로 표시할지는 소유자가 결정해야 합니다.
