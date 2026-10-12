# 자체 감사 보고 — 프로젝트(런처·도구·메타데이터·시험) · 2026-10-12

- 대상: `design/gui-redesign-proposal` 브랜치 (0.3.71 표기). 플러그인 본문(`PROGRAM/plugins/*.js`)은 **수정하지 않았습니다**.
- 방법:
  - 런처·업데이터·메타데이터·문서 정적 감사
  - 읽기 전용 도구 실행
  - `run_regression_batch.py`로 회귀 1,139개 전부 실행 (커밋 `809d0ca`, 장시간 3개는 하나씩 따로)
- 환경: Node v22.23.3, CPU 8개, 네트워크 없음. 그래서 `node_modules`(jsdom·acorn·terser), 브라우저 실행 파일, IPv6 루프백이 없습니다.
- 검토 범위: 이 문서의 프로젝트 수정은 디자인 PR(#3)에 별도 커밋(76ed012, 809d0ca 및 후속)으로 들어 있습니다.

## 1. 회귀 결과

> **정정 (2026-10-12 2차 기록).** 처음 이 절에는 수정 전후가 섞인 실행 결과를 집계해 적었습니다. "약 52", "61개가 환경 문제", "14~55분"처럼 근거가 부족하거나 틀린 표현도 있었습니다. 아래는 커밋 `809d0ca`에서 1,139개 전부를 다시 실행한 결과입니다. 시험별 원본 결과·분류·실패 전체 출력은 [`regression/selfaudit-20261012/`](regression/selfaudit-20261012/README.md)에 있습니다.

| 상태 | 수 |
|---|---|
| PASS | 1,073 |
| PASS_SKIP | 2 |
| FAIL | 64 |

실패 분류(시험별 목록은 `FAILURES.tsv`):

| 분류 | 수 |
|---|---|
| jsdom 없음 | 30 |
| acorn 없음 (도구가 acorn 필요를 명시한 경우 포함) | 20 |
| 브라우저 없음 | 4 |
| IPv6 루프백 없음 | 1 |
| 외부 산출물·증거 경로 필요 | 3 |
| 부하 민감 (단독 3회 중 실패 포함 2개) | 3 |
| 고정 기준이 확보한 저장소 자료에 없음 | 2 |
| 실행 방식 전제 (`NODE_OPTIONS` guard) | 1 |

- 앞의 55개(30+20+4+1)는 설치·환경으로 해결될 것으로 봅니다. 다만 이 환경에서는 설치해서 다시 돌려 보지 못했으므로 확인한 결과가 아닙니다.
- 나머지 9개는 환경만으로는 해결되지 않습니다.
- `compute_product_worker_overlap`, `libra_micro_inherited_t5_overlap_3mode`는 단독 실행에서도 실패한 적이 있어, 불안정한 시험(또는 동시성 결함)으로 따로 조사해야 합니다.

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
| F12 | `run_regression_batch.py`: 헤더에 GRADIA 누락, POSIX에서 자식이 stdin 상속, Ctrl-C·SIGTERM 때 시험이 띄운 서버가 남음 | GRADIA 추가, `stdin=DEVNULL`. 정리는 처음(76ed012)에 프로세스 그룹만 죽여서 **별도 그룹의 detached 서버를 놓쳤습니다**(6차 검토 지적). 809d0ca부터는 시험마다 환경 토큰을 주고, 토큰·부모 표로 찾은 자손과 그 그룹을 정리합니다(Ctrl-C·timeout·정상 종료 뒤). 이후 SIGTERM도 같은 경로를 탑니다 | `regression_owned_process_cleanup_test`: 정상 종료·SIGINT·SIGTERM 세 경우를 검사하고, 이전 실행기에서는 FAIL. `regression_skip_detection_test` PASS. 한계: 환경을 통째로 바꾸고 부모가 먼저 끝난 자손은 찾지 못할 수 있음 |
| F11 | `_common.cmd` 안내 "Node.js 22 이상" (실제 22.13 이상) | 문구 정정 | — |
| F13 | `SHA256SUMS.txt`·`program-manifest.json`이 `docs/gui-redesign/**` 12개를 포함하지 않음 | `tools/update_manifest.cjs` → `tools/update_checksums.cjs --distribution`으로 재생성 | `sha256sum -c SHA256SUMS.txt`로 목록의 모든 파일 바이트를 다시 해시해 대조(불일치 0). manifest·checksum·builder 관련 시험 26개 중 acorn이 필요한 1개 외 PASS |
| F17 | `tools/install_runtime.ps1` 줄바꿈 혼용 | CRLF로 통일 | — |
| R3 | 포터빌리티 검사기가 `/root`(root의 홈)를 사용자 경로로 보지 않음. root로 실행하면 검사기 시험의 고정 경로를 놓쳐 실패 (의존성 문제가 아니라 검사기 결함) | `/root`, `/var/root`를 홈 경로 패턴에 추가 | `source_tree_portability_scanner_test` PASS, 실제 트리 검사(`source_tree_portability_test`) PASS |

## 3. 수정하지 않은 것 (소유자 결정 필요)

- **F02 버전**: 공개 stable 릴리스·태그 `0.3.71` 이후 커밋이 139개입니다(이 감사 이전 기준). 그 사이 World Manager 제거와 서버·플러그인 변경이 있었지만 버전 표기는 같습니다. updater는 더 높은 버전만 업데이트로 알리므로, 다음 배포 전에 버전을 올려야 합니다.
- **F03 공개 릴리스 자격**: 태그 시점의 `update-manifest.json`은 `offline_candidate`/`updaterEligible:false`입니다. 공개 ZIP **내부**의 manifest는 이 환경에서 받을 수 없어 확인하지 못했습니다. 그래서 실제로 updater가 거부하는지는 **확정하지 않았습니다**.
- **F04 `PUBLICATION-PROVENANCE.json`**: 현재 트리와 맞지 않는 진술이 있습니다. 하지만 과거 게시 기록이므로 **고치지 않고 보존하고**, 다음 빌드의 출처 기록을 새 파일로 따로 만드는 것이 맞습니다.
- **F14** tag 표기(`v0.3.71` vs `0.3.71`), **F15** 문서 링크 7개 깨짐, **F16** 안내 텍스트 3종 차이, **F09** `_server_foreground.cmd` 진단 경로·임시 로그, **F11** POSIX 런처에 PATH node 대체 경로 없음.
- `audit_flashback_manifest_locks.cjs`: 잠금 밖 저장 호출 11건이 보고됩니다. 플러그인 내부라 범위 밖이며, 의도된 예외인지 판단이 필요합니다.
- 부하 민감 시험 2개(`compute_product_worker_overlap`, `libra_micro_inherited_t5_overlap_3mode`): 단독 실행에서도 실패한 적이 있습니다. 원인 조사가 필요합니다.

## 4. 확인이 필요한 시험 고정값

`namespace_reset_all5_composition`의 `tests/fixtures/retrace_all5_reset_fixture.cjs`는 `plugins/RETRACE.js` SHA-256을 `366fcfab…`로 고정합니다. `hayaku_canonical_builtin_access_runtime`은 기준 커밋 `9ae0719…`, `a7c6e8a…`를 요구합니다.

- 확인한 범위: `origin`의 모든 ref(브랜치·태그·PR 포함 12개, 커밋 150개)를 가져와 찾았습니다. 해시는 RETRACE.js 5개 버전 어느 것과도 일치하지 않았고, 커밋 3개도 없었습니다.
- `docs/regression/FIX39_PROCESSING_20261011.json`도 같은 값을 `missingSourcePins`(누락 커밋 `38946c7…`)로 기록하고 있습니다.

따라서 **확보한 자료에서는 찾지 못했다**는 것까지가 확인한 사실입니다. 저장소 밖에 기준이 있을 수 있습니다. 현재 해시로 바꿔 통과시키면 시험이 지키려는 동일성 검증이 사라지므로 바꾸지 않았습니다. 기준 자료를 확보할지, 시험을 "외부 차단"으로 분류할지는 소유자가 정해야 합니다.
