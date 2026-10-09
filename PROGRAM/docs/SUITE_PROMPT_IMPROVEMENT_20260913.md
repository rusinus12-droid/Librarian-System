# 세 제품 프롬프트 구현 및 이전 정본 비교

작성일: 2026-09-13

## 결론과 검증 범위

LIBRA 2.3.112 / HAYAKU 3.0.119 / Flashback 1.0.80 소스에 적용했다. 과업과 증거의 의미를 분리하고 일부 중복을 줄였다. 실제 빌더/호스트 호출 인자 fixture로 이전 정본과 비교했으며, 실제 RisuAI 설치 또는 Gemini 등 공급자 호출은 수행하지 않았다. 따라서 구조·문안·로컬 회귀 결과와 모델의 실제 누락률/사실성 개선을 구분해야 한다. 후자는 미측정이며 의미 품질 채택 조건 통과로 간주하지 않는다.

## 전체 백업과 비교 기준

- 구현 직전 MemorySuite 전체: `backups/suite-prompt-redesign-2026-09-13T13-43-33-133Z/MemorySuite` (작업공간 기준).
- 854파일, 27,687,027바이트, 34디렉터리. DATA 15파일 및 빈 디렉터리를 포함한다. 기존 역사적 백업을 다시 재귀 복사하지 않았다.
- 파일별 SHA-256 대조 후 원본을 다시 읽어 복사 중 변경이 없음을 확인했다. 백업 manifest는 같은 백업 상위 디렉터리에 있다.
- 비교 기준 버전: LIBRA 2.3.111, HAYAKU 3.0.118, Flashback 1.0.79. 이번 작업 이전에 존재한 수정도 이 기준에 포함한다.
- 감사에서 백업 854파일을 재검증하고 DATA 15파일 불변을 확인했다. 플러그인 3개는 별도 rollback-readback 디렉터리로 복원하여 바이트를 대조했다. 운영 DATA를 과거 상태로 덮어쓴 것은 아니다.

## 제품별 변경

### HAYAKU

정규 full/compact/critical 공유 작성 규칙에서 패킷 전용 범위를 첫머리로 이동했다. 근거 있는 요약만으로도 유효하고, 근거 없는 축을 채우지 않는다는 기준을 바로 뒤에 배치했다. 이후 근거와 시간, 실행 스키마, scene/lineage/봉투, 선택적 인용, 세부 보존 규칙과 언어/JSON 순서로 정리했다. 기존 예시는 유지하며 설명만 줄였다.

native 공통 규칙에는 대상 증거 단위 당시의 사실과 나중에 얻은 지식을 구분하는 지시를 추가했다. primary/repair, 단일/배치 대상과 봉투 생성은 그대로다. 정규 grounding은 선택 사항, native grounding은 필수라는 차이를 유지했다.

기존 주입 누락 보정, receipt/hash 검사, 출력 슬롯, 런타임 lineage, 파서, 저장/readback 및 복구 호출 정책을 변경하지 않았다. 세 슬롯의 runtime/terminal seal은 fixture에서 이전 정본과 바이트가 같다. 정규 작성에 추가 모델 호출을 도입하지 않았다.

### LIBRA

Librarian 고정 계약을 완성한 뒤 정규식으로 네 문장을 교체하던 조립을 직접적인 문장 조립으로 바꿨다. 이 구조 변경만 적용한 중간 단계에서 최종 system 문자열이 이전 정본과 바이트 단위로 같음을 확인한 뒤 문안을 개선했다. 소스에 있던 긴 설명이 실제 전송되었던 것처럼 비교하지 않았다.

프로필 설명을 줄이되 단발 행동/인용/성공으로 장기 성향·습관·말투·능력을 추론하지 않는 제한을 보존했다. 성인 연속성 공통 규칙은 원문 그대로 유지하고 그와 중복된 첫 문장만 줄였다. 기존 typed shape, 관계 방향, 선택적 State binding, 삭제/누적 규칙과 실제 user 증거 입력은 유지했다.

Planner는 현재 입력을 해석하는 권한과 완료 사건을 입증하는 근거를 분리했다. SGA SHADOW 및 실제 character/world/plot AIDE의 자료 격리 설명을 정리하고, 최종 전달에 요청/시도/완료 행위 구분을 명시했다. Input Writer도 작성 우선순위와 사건 증거를 분리했다. 선택·전송 전 후보의 비정본성, 사용자 주도권, 독립 언어 설정, 출력 형식, 캐시 비활성 정책, 모델 호출·정본/State 저장 경로는 유지했다.

### Flashback

발췌 전체를 일괄적으로 ‘실제 발생 사건의 권위 있는 증거’라고 선언하던 문장을 당시 원문이 입증하는 사실로 한정했다. 발언과 사실, 요청과 결과, 역사적 사실과 현재 상태/인물 지식을 구분한다. GAP 외 두 종류의 생략 마커와 부분 발췌의 한계를 명시했다. 경계·거절·철회와 결과를 보존하고 동의나 민감 속성을 추론하지 않는 규칙을 보완했다.

정적 계약 revision을 7에서 8로 올려 기존 캐시를 재사용하지 않도록 했다. raw 발췌, 검색/선택/동적 렌더링, 캡처와 동기화 코드는 변경하지 않았다. 호스트 잔여 예산에서 정적 계약 길이를 빼는 경로를 확인하여 최종 정적 문안을 기존보다 짧게 조정했다.

## 실제 조립 길이 비교

문자 수는 고정된 합성 입력의 JavaScript 문자열 길이이며 공급자 토큰 수가 아니다. 스냅샷 33종은 `review_artifacts/suite_prompt_implementation_20260913/{baseline,final}/prompts/manifest.json`에 기록했다. HAYAKU hook 반환값에는 실행별 lineage가 포함되므로 그 해시 차이를 의미 차이로 해석하지 않는다.

| 경로 | 이전 | 이후 | 변화 |
|---|---:|---:|---:|
| HAYAKU regular full | 6,357 | 6,163 | -194 |
| HAYAKU compact | 5,365 | 5,236 | -129 |
| HAYAKU critical | 5,184 | 5,055 | -129 |
| HAYAKU native/repair 6종 | 경로별 상이 | 경로별 상이 | 각각 +85 |
| LIBRA Librarian system | 11,623 | 11,364 | -259 |
| LIBRA Planner | 9,118 | 9,322 | +204 |
| LIBRA SHADOW 4종/AIDE 3종 | 경로별 상이 | 경로별 상이 | 각각 -96 |
| LIBRA 최종 전달 | 7,268 | 7,420 | +152 |
| LIBRA Input Writer 4종 | 경로별 상이 | 경로별 상이 | 각각 +79 |
| Flashback static | 1,536 | 1,459 | -77 |

HAYAKU fixture의 atomicMinimumChars는 6,523→6,394, totalChars는 7,693→7,499다. 예산 절벽은 줄었으나 없어졌다고 볼 수 없다. native 및 일부 LIBRA 경로는 문장이 길어져 비용/컨텍스트 관점에서는 증가 요인이 있다. 전체 토큰 비용 감소로 보고하지 않는다.

## 회귀 결과와 기존 실패

기본 비교 21개는 이전/최종 모두 15통과, 6실패였다. 통과하던 검사가 새로 실패한 경우는 없다. 실패 파일과 오류 지점/종류를 비교했다.

| 기존 실패 | 관찰 |
|---|---|
| hayaku_schema_wrapper_runtime_test | 24행: bridge_incremental_recovery_api와 partial_memory_saved 기대 불일치 |
| hayaku_native_cold_start_contract_identity_test | 30행: false/true 불일치 |
| hayaku_partial_outcome_binding_runtime_test | 31행: fixture의 hayakuRecoveryBlocked 미정의 |
| libra_planner_memory_grounded_reaction_runtime_test | 10행: 2.3.86 버전 고정 단언에서 정본/최종 모두 중단. 이후 의미 검사를 통과했다고 간주하지 않음 |
| flashback_source_diff_transaction_v130_test | 14행: wait timeout |
| flashback_worldline_workspace_v129_runtime_test | 19행: GUI 계약 단언 실패 |

이 실패들은 해결되지 않았으며 전체 시스템 정상 판정에서 제외할 수 없다. 이번 프롬프트 변경이 만든 실패와도 혼동하지 않는다. 추가 6개 비교(정본 우선 로컬/서버 저장, 선택적 State 연결, 통합 저장 실패 복구, fact pipeline, HAYAKU cold-start batch)는 이전/최종 모두 통과했다. 합계 27개 비교는 양쪽 모두 21통과·기존 6실패이며 신규 실패는 없다. 결과는 작업 아티팩트 `extra-results.json`에 기록했다.

## 개선/퇴행 판정

- 확인된 개선: LIBRA 조립의 숨은 정규식 교체 제거, 과업/증거/시간 구분 명시, HAYAKU 정규 및 Flashback 정적 계약의 예산 감소.
- 검사 범위 내 퇴행: 기본 비교 검사에서 새 실패 없음. DATA 및 비대상 실행 코드 보존. 이는 모든 실행/공급자 조합의 무퇴행 보장이 아니다.
- 비용상 증가: HAYAKU native와 LIBRA Planner/최종 전달/Input Writer의 문자가 소폭 증가했다.
- 미확인: 실제 Gemini 패킷 누락률, 사실 누락/날조율, 서사 품질, 공급자 변환 후 메시지 및 라이브 RisuAI 행동. 이번 스냅샷과 mock 응답으로 의미 품질 향상을 입증하지 않는다.
- 추가 대조 예시, 새 축약 계층, 캐시 정책 변경은 채택하지 않았다. 계획의 모델별 반복 A/B 의미 평가도 미실행이다. 공급자 평가 전까지 본 변경은 로컬 구현·회귀 확인 상태이며 의미 품질 최종 승인은 아니다.

## 재검증 근거

작업공간의 `review_artifacts/suite_prompt_implementation_20260913/`에 백업 정보, baseline/candidate/final 검사 로그, 조립 스냅샷, 제품별 `.diff`, `audit.json`, 격리 복원본 및 재실행 스크립트를 남겼다. 최종 소스 확정 후 release guides → program manifest → SHA256SUMS 순으로 갱신했다. release_metadata_test 및 distribution_metadata_coherence_test가 통과했다. 물리적 해시 readback 결과는 `release-readback.json`에 기록한다. SDK 복사본과 DATA는 교체하지 않았다.
