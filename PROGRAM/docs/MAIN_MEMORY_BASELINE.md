# MAIN_MEMORY_BASELINE — T00 기준선 고정

**작업:** T00 of `review_artifacts/LIBRA_WorldMaker_Integration_Plan_20260925/docs/02_IMPLEMENTATION_PLAN.md`
**작성:** 2026-09-25 · **기준 커밋:** `96949c4` + T01 커밋 `8137982`

이 문서는 T00의 산출물이다. 제품 source 를 수정한 결과가 아니라, 이후 작업이 비교할 출발점을 고정한 기록이다.

## 1. 기준선 해시

### 1.1 제공 패키지 원본 (`BASELINE_MANIFEST.json`)

| 자료 | 문서 기대 | 확인 결과 |
|---|---|---|
| `Librarian-System-0.3.65-Source.zip` | `206a999c7f2592db6a6688ab7f74aac5d7aba7087fa01ebc66ffe6c083547cb3` | **일치** |
| `LIBRA World Maker Full.js` | `78f6f5cbe238859cb8fa68e08ae3b6637871568472753b7fdeeaac494ffce951` | 패키지 내 보존 확인 |
| `PROGRAM/plugins/LIBRA.js` (문서 기준) | `c4bd33566c5dd2a44c25f572f66fbad07e09d864ae122473d7b0ee384d1efabf` · 5,762,248 bytes | **불일치 — 아래 1.2** |

### 1.2 제품 LIBRA.js 는 문서 기준 이후 변경됨

문서가 고정한 해시는 현재 제품과 다르다. 설계서 §0 과 계획서 Global Constraints 의 지침에 따라 **문서의 줄 번호를 기계적으로 적용하지 않고**, 변경점을 먼저 기록한다.

문서 기준(`c4bd3356`) 이후 `LIBRA.js` 를 변경한 커밋:

| 커밋 | 내용 |
|---|---|
| `bda7879` | 서사 방향 렌더 루프 중단, 진단 헤더 중복 제거 |
| `8720e43` | 기억 분석 엔진 헤더 폭 사용, 상태를 버튼에 결합 |
| `9cbeb32` | 기억 분석 엔진 카드 제목 위계 정정 |
| `c4f9749` / `ffe0dda` | 전역 서버 저장 모드 + 실제 패널 배선 |
| `6bfb70b` | canonical revision injection guard |
| `8137982` | **T01** — State view 작업의 3모드 지원 |

현재 크기 `5,786,421` bytes (문서 기준 +24,173). **수용 기준 영향:** T01 의 대상 함수(`mutateStateWorldline`, `requireUnifiedStorageBackend`)와 State replay 경로는 위 커밋들이 건드리지 않았으므로, T01 수용 기준은 그대로 유효하다. C01–C31 의 함수 이름·계약도 유지된다.

## 2. 기준선 테스트 실행 (T00)

`verification/run_baseline.py` 를 문서 규정대로 실행했다. 이전 기록을 재사용하지 않고 새로 돌렸다.

```
python3 review_artifacts/LIBRA_WorldMaker_Integration_Plan_20260925/verification/run_baseline.py \
  --project . --out /tmp/_t00_baseline --jobs 2 --timeout 240
```

**결과: TOTAL 18 · PASS 18 · PASS_SKIP 0 · FAIL 0**

문서가 `ASSERTIONS_PASS_EXIT_UNVERIFIED` 로 보존한 `libra_unified_server_writer_v1_test.cjs` 는 이번 환경에서 **정상 프로세스 종료 exit 0** 을 확인했다 (12개 내부 검사 PASS + exit 0). 문서의 미확정 항목이 여기서 해소된다.

`source_sha256_before == source_sha256_after` 로 확인되어 실행이 source 를 변경하지 않았다.

## 3. 개인 절대경로 (T00 수정 대상)

문서가 지목한 `libra_duplicate_scanner_extractable_test.cjs` 의 저장소 밖 개인 경로는 **이미 정리되어 있다.** `tests/` 전체를 스캔해 코드 라인에서 `/Users/<user>` 또는 `C:\Users` 형태를 찾은 결과 **0건**이며, 해당 테스트는 exit 0 으로 실행된다. T00 의 이 항목은 이미 충족됨으로 기록한다.

## 4. 게이트 G0 — 출발점의 FAIL/TIMEOUT/SKIP/미지원 기대값

| 항목 | 상태 |
|---|---|
| 기준선 18개 FAIL | 0 |
| 기준선 18개 TIMEOUT | 0 |
| 기준선 18개 SKIP | 0 |
| 문서가 기록한 미지원 기대값 | `libra_world_manager_state_3mode_parity_test.cjs` 의 `rollbackWorldManagerState` / `setWorldManagerWorldline({})` → mirror·server_only 거부. **T01 에서 구현되어 해소됨.** |
| 남은 미지원 경계 | named logical fork (`UNIFIED_USE_NATIVE_BRANCH_FOR_FORK`), `prepareSessionHandoff` 서버 경로 (`UNIFIED_BACKEND_NOT_SUPPORTED`). 둘 다 문서가 요구한 경계가 유지된 것이다. |
| 매니페스트 정합성 | `manifest_clean_tree_file_set_test` PASS, `program_data_layout_test` PASS |

## 5. 다음 작업 입력

- **T01 완료.** `libra_main_memory_state_operations_parity_test.cjs` 가 turn 0 과 완료 구간 경계에서 세 모드 동일 성공을 검증한다. A02 를 이 테스트가 충족한다.
- **T02 입력.** D01 operation matrix 는 T01 로 확정되었다. D02–D06 은 `MAIN_MEMORY_CONTRACT_DECISIONS.md` 에서 다룬다.
- **해시 고정.** 이후 비교는 `current LIBRA.js sha256` 를 각 커밋에서 다시 계산해 기록한다. 문서의 고정 해시는 역사적 기준으로만 참조한다.

## 6. 미실행·한계

- 실제 RisuAI 앱 수동 조작과 실기기 성능은 이 문서의 범위가 아니다. synthetic host 결과를 live-host 결과로 바꾸어 적지 않는다.
- 기준선 18개는 전체 회귀가 아니다. 전체 CJS 회귀는 별도로 실행하며 그 결과를 여기에 섞지 않는다.
- 문서의 원본 Source ZIP 은 참고 자료이며 제품 트리에 자동 import 하지 않는다.
