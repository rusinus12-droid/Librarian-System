# 자체 감사 회귀 실행 기록 — 2026-10-12

## 실행 조건
- 코드: 커밋 `809d0ca` (플러그인 본문은 공개 `0.3.71` 이후 변경 없음, 이 감사에서도 수정 안 함)
- 환경: Linux 샌드박스, CPU 8개, Node v22.23.3, Python 3.11, 네트워크 없음
  - `node_modules` 없음 (jsdom·acorn·terser 미설치), Chromium 계열 브라우저 없음, IPv6 루프백(`::1`) 없음
- 실행기: `PROGRAM/run_regression_batch.py`. 이 샌드박스는 한 번의 호출이 끝나면 프로세스를 정리하므로, 범위(start end)를 나눠 차례로 실행했습니다. 실행기 출력의 `[full_output_log=…]` 경로는 이 샌드박스 경로입니다.
  - 1,136개는 나눠 실행했습니다.
  - 오래 걸리는 3개(`libra_main_memory_letter_lifecycle_105turn`, `libra_phase_d_candidate_context_scale`, `libra_phase_d_timeline_caps`)는 `--match`로 하나씩 따로 실행했습니다.
- 나눠 실행할 때 제 래퍼가 시간 제한(580초)에 걸린 범위가 있습니다. 그 범위는 마지막 완료 시험 다음 번호부터 다시 시작했고, 결과가 빠진 시험은 없습니다(1,139/1,139).

## 결과 (1,139개 전체)

| 상태 | 수 |
|---|---|
| PASS | 1,073 |
| PASS_SKIP (일부 건너뜀을 스스로 알린 시험) | 2 |
| FAIL | 64 |
| TIMEOUT | 0 |

`RESULTS.tsv`에 시험별 상태·소요 시간·정리 결과가 있습니다. 실패 64개는 `FAILURES.tsv`에 분류·사유·첫 근거 줄과 함께 정리했고, 전체 출력은 `failure-logs/`에 있습니다.

## 실패 분류 (시험별 목록은 `FAILURES.tsv`)

| 분류 | 수 | 근거 |
|---|---|---|
| `missing_jsdom` 개발 의존성 jsdom 없음 | 30 | `Cannot find module 'jsdom'` |
| `missing_acorn` 개발 의존성 acorn 없음 | 20 | `Cannot find module 'acorn'` 또는 시험·도구가 acorn 필요를 명시: `Acorn is required…`, `release_key_pool_acorn_unavailable`, `manifest_declaration_parser_unavailable`, 빌더의 `release_test_surface_acorn_unavailable`. 빌더 내부 smoke 실패도 여기에 포함 |
| `no_browser` 브라우저 실행 파일 없음 | 4 | `No Chromium-family browser was found` |
| `external_input` 외부 산출물·증거 경로를 환경변수로 받아야 함 | 3 | `ULTRALIGHT_ARTIFACT_DIR`/`RELEASE_PARITY_CONTROL_DIR`, `FLASHBACK_SERVER_INSPECTION_ARTIFACTS`, 외부 증거 디렉터리 |
| `timing` 부하에서 동시성·대기 조건 미충족 | 3 | 아래 "부하 민감 시험" |
| `missing_history` 고정 기준이 확보한 저장소 자료에 없음 | 2 | 아래 "고정 기준" |
| `no_ipv6` | 1 | `listen EADDRNOTAVAIL ::1` |
| `invocation` 실행 방식 전제 | 1 | `namespace_reset_physical_admission`: A4 guard를 `NODE_OPTIONS`에 넣고 실행해야 함. 기본 실행기는 넣지 않으며, 프로젝트의 기존 원장(`regression-checkpoints/20261010T1900Z`, `regression/fix39-20261011`)에도 FAIL로 기록되어 있음 |

**환경 설치로 해결될 것으로 보는 실패**는 의존성·브라우저·IPv6 55개(30+20+4+1)입니다. 다만 이 환경에서는 설치해서 다시 돌려 보지 못했으므로, "설치하면 통과한다"는 것은 확인하지 않은 추정입니다. 나머지 9개는 환경 설치만으로는 해결되지 않습니다(외부 입력 3, 부하 민감 3, 고정 기준 2, 실행 방식 1).

### 부하 민감 시험 (단독 재실행 3회, `ISOLATED_RERUNS.tsv`)
| 시험 | 전체 실행 | 단독 3회 |
|---|---|---|
| `compute_four_namespace_product_load_test` | FAIL (peakJobs 3/4) | 3회 PASS |
| `compute_product_worker_overlap_test` | FAIL (peakJobs 3/4) | 1회 FAIL, 2회 PASS |
| `libra_micro_inherited_t5_overlap_3mode_test` | FAIL (T5 Micro 대기 시간 초과) | 1회 FAIL, 2회 PASS |

뒤의 두 시험은 단독으로 돌려도 결과가 흔들립니다. 따라서 환경 문제로 보지 않고 **불안정한 시험(또는 동시성 결함)으로 따로 조사가 필요**합니다. 이번 감사에서는 고치지 않았습니다.

### 고정 기준이 확보한 자료에 없는 시험
- `hayaku_canonical_builtin_access_runtime`: 기준 커밋 `9ae0719…`, `a7c6e8a…`이 필요합니다.
- `namespace_reset_all5_composition`: `plugins/RETRACE.js` SHA-256 `366fcfab…`이 필요합니다.
- 확인한 범위: `origin`에서 가져온 모든 ref(브랜치·태그·PR 포함 12개, 커밋 150개)와 그 안의 RETRACE.js 5개 버전에서 찾지 못했습니다. 누락 커밋 `38946c7…`도 없습니다.
- 이 저장소 밖(다른 저장소나 원본 개발 환경)에 있는지는 알 수 없습니다. 현재 해시로 바꿔 통과시키는 것은 시험의 목적(특정 기준과의 동일성)을 없애므로 하지 않았습니다.

## 이 감사의 수정으로 결과가 바뀐 시험
수정 전 첫 실행에서 FAIL이었던 줄은 `PREFIX_RUN_EXCERPT.txt`에 원문 그대로 있습니다.

| 시험 | 수정 전 | 수정 후 | 수정 |
|---|---|---|---|
| `authority_crash_recovery.test` | FAIL | PASS | 자식 프로세스 SQLite 경고 (76ed012) |
| `distribution_runtime_dependency_closure_test` | FAIL | PASS | `node:sqlite` 내장 판정 (76ed012) |
| `source_tree_portability_scanner_test` | FAIL | PASS | `/root` 홈 경로 인식 (809d0ca) |
| `regression_owned_process_cleanup_test` (신규) | — | PASS | detached 자손 정리 (809d0ca). 이전 실행기에서는 FAIL |

## 오래 걸리는 시험 3개 (`--match`로 하나씩 실행)
| 시험 | 실행기 제한시간 | 프로젝트 기록의 단독 측정값 (실행기 주석) | 이번 측정 |
|---|---|---|---|
| `libra_main_memory_letter_lifecycle_105turn` | 840초 | 3모드 합계 640.57초 | PASS 103.86초 |
| `libra_phase_d_candidate_context_scale` | 1,800초 | 1,427.85초 | PASS 550.90초 |
| `libra_phase_d_timeline_caps` | 3,300초 | 2,634.65초 | PASS 955.72초 |

이전 보고서에 적은 "14~55분"은 제한시간을 분으로 바꾼 값이었고, 실제 소요 시간이 아니었습니다.

## 실행기 정리 동작
- 전체 실행에서 `cleanup=not_timed_out`가 1,136/1,136이었습니다. 정상 종료 뒤 남은 자손 프로세스가 발견된 시험은 없었습니다.
- 809d0ca의 detached 자손 정리 경로는 `regression_owned_process_cleanup_test`로 확인했습니다(정상 종료와 SIGINT).
- 이 기록 이후 SIGTERM도 같은 경로를 타도록 실행기를 고쳤습니다. 그 변경 뒤에는 실행기 관련 시험 2개만 다시 돌렸습니다.
