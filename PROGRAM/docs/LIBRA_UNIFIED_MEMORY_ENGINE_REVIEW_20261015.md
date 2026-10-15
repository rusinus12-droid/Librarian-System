# LIBRA 통합 메모리 엔진 — 최근 커밋 리뷰와 후속 패치

- 작성일: 2026-10-15 · 버전: 1.1
- 기준: `codex/libra-memory-network-20261013`, [`25cbd13..923580b`](https://github.com/rusinus12-droid/Librarian-System/compare/25cbd13...923580b), 9개 커밋
- 범위: 변경된 source/embedded 코드, owner 증명·체크포인트·GC의 실제 등록 API, 기존 소비자·검색 회귀
- 최신 리뷰: `df9d1e4..f8fce44`의 7개 커밋과 후속 패치는 §5를 우선한다. §1–4는 이전 리뷰의 이력이다.
- 관련: [현황 §23](LIBRA_UNIFIED_MEMORY_ENGINE_STATUS_20261014.md), [잔여 과제 v1.7](LIBRA_UNIFIED_MEMORY_ENGINE_NEXT_TASKS_20261014.md)

## 1. 평가와 구현 범위

증분 owner 증명(N01-A), 구간 projection 재사용·체크포인트·대형 행 분할(N01-B)은 통합 엔진의 실제 접근 비용을 다루는 진척이다. State 근거의 읽을 수 있는 텍스트와 퇴역 API/서버 읽기를 전제로 한 테스트 정리도 목적에 맞는다. 다만 아래 현재성·삭제 경계가 재현돼 기능 이름과 테스트 PASS만으로 N01/N05 완료를 인정할 수 없었다.

일부 retargeted 테스트는 제어된 owner-read provider fixture를 사용한다. 이들은 readonly 계약·출처·초안 수명을 검사하지만 실제 native unified compiler 경로의 증거를 대신하지 않는다. 별도의 실제 LIBRA/SQLite/GRADIA native suite를 함께 실행해 연결을 확인한다. 전체 저장소 전수 회귀나 실제 설치 RisuAI·실제 embedding 모델 품질 인증은 이번 범위가 아니다.

## 2. 재현한 문제와 수정

### R15-1 · P1 · 투영과 다른 본문을 proof baseline으로 인증

`1aa630e`의 native `captureSourceProof()`는 graph를 만든 뒤 source를 다시 읽고 **그때 처음 얻은** digest를 저장했다. 투영 직후 Micro 본문을 바꾸고 ref/head를 그대로 두면 이전 graph와 새 본문 digest가 함께 게시됐다. 최종 검증은 새 digest와 새 본문이 같다는 것만 확인하므로 이전 graph의 근거를 차단하지 못한다.

**재현:** `readMemoryGraphProjection`의 구간 열거가 끝난 뒤 실제 `captureSourceProof` 진입 직전에 Micro claim 본문을 변경한다. 기준 코드는 구축을 성공시켰다(`assert.rejects`의 Missing expected rejection). 수정 후 `SOURCE_BODY_CHANGED`로 root 게시를 거부한다.

**수정:** native 투영의 최종 logical readback 전에 physical body SHA-256 baseline을 캡처한다. 구간 간 동일 키의 baseline 불일치와 이후 capture의 본문 변경을 거부한다. 재사용한 구간은 검증된 이전 baseline만 이어받는다. 최종 물리 검증에서 필요한 baseline이 없으면 거부한다.

새 계약은 `libra.source_proof_contract.v2`다. 이전 v1 게시물은 전체 native 재투영으로 읽고 과거 baseline을 발송 권한에 사용하지 않는다. query가 원본/인덱스를 자동 변경하지 않는다. v2 유지보수 재구축 후 다시 증분 검증을 사용한다.

### R15-2 · P1 · 새 root 게시와 native GC 삭제 사이의 경합

`31a819e`는 process-local Map을 fence로 발급하고, root/key 목록을 다시 읽은 뒤 삭제했다. 서버 조건부 batch도 이미 열거한 root들만 조건으로 둔다. 새 root의 생성, 다른 VM의 build/reader, 마지막 검사 이후 시작한 작업을 삭제와 같은 원자적 경계에서 막지 못한다.

**재현:** 도달하지 않는 유효한 generation 후보를 만들고, plugin_only의 remove 또는 server_only의 조건부 remove batch 직전에 그 후보를 참조하는 새 root를 독립 게시한다. 기준 코드의 **두 저장 모드 모두** 새 root가 참조하는 generation을 삭제했다.

**수정:** 실제 owner namespace fence가 없으므로 native inventory는 fence를 발급하지 않고 destructive adapter도 제공하지 않는다. dry-run/관찰은 유지한다. 실제 sweep은 `blocked_atomic_gc_unavailable`, `deletedKeys:[]`이며 remove transport 자체를 호출하지 않는다. N05의 owner 프로토콜 구현은 미완료다. per-root CAS나 runtime pin Map으로 이를 대체하지 않는다.

### R15-3 · P2 · 검증하지 않은 checkpoint 재사용

`e658d49`의 `resolveIncrementalPlan()`은 저장된 slice 전체를 기본 reusable로 두었다. owner proof가 없거나 검증 결과가 null이어도 기본값이 유지됐다. checkpoint 키도 본문 digest에 결속되지 않아 저장 payload의 단순 변조를 확인하지 않았다.

**수정:** reusable은 빈 집합에서 시작하고 유효한 owner 검증이 승인한 slice만 추가한다. checkpoint는 proof version·payload digest를 확인하며 이전/검증 불가/손상 checkpoint는 재열거한다. 원본 변경·null verifier·변조 후 재구축에서 이전 slice를 재사용하지 않는 회귀를 추가했다. 이 검사는 커널의 미지원/custom owner 경계도 포함하며 모두 native owner에서 직접 노출된 결함이라고 일반화하지 않는다. 또한 checkpoint scan은 64개로 제한됐지만 maxWindows는 128까지 허용해 한 구간씩 재개하면 65구간에서 반복 정체됐다. 67구간 음성 대조로 확인하고 읽기/쓰기 attempt 상한을 128로 맞췄다. 상한 소진은 `CHECKPOINT_BUDGET`으로 명시적 거부하며 full build는 가능하다.

### R15-4 · P2 · 누적 전송량과 동시 버퍼를 혼동

새 byte inventory 연결은 누적 `laneReport.bytesRead`를 `ownerIoInFlightBytes`로 전달하고 미측정 write barrier를 0으로 대입했다. 값이 존재해도 실제 peak active buffer나 barrier 계측을 의미하지 않는다.

**수정:** 두 미측정값을 null·missingMeasurements로 보존한다. Lane 누적 payload byte는 원래 counter로 계속 보고한다. source·원본 Map·representation·동시 I/O/peak heap 전체 admission은 N01-C 후속이며 `byteBounded:false`를 유지한다.

## 3. 검증과 재현

기준 `923580b`에서 새 source-capture 회귀와 native GC 두 모드 회귀, proof 없는 checkpoint 재사용 검사가 실패한 것을 먼저 확인했다. 패치 후 새 회귀 8건(커널 5, 등록 native 3)과 영향권 suite를 실행했다. 별도 새 테스트 이름만으로 전체 품질/규모 합격을 주장하지 않는다.

| 묶음 | 확인 범위 |
| --- | --- |
| corpus·inventory·selective·query·compiler·consumers·rollout·patch contract | 19개 corpus 검사(기존 14 + 새 5), 구간 증명·분할 재조립·선택적 페이지·오염/취소·최종 권한·비용 단위. rollout의 native sweep 단언은 실제 owner capability 부재에 맞춰 차단/보존으로 수정 |
| native corpus·incremental·semantic·replacement·patch·새 경계 | plugin_only/server_only, 재시작·원본 변경·다중 readset, v2 정상 증분/구축 재개, 변경 본문 capture 거부, v1 native 호환, GC 삭제 transport 0, Classic/GUI·최종 전달·source 수정 차단 |
| GRADIA native 두 suite | 실제 LIBRA kernel·인증 plugin channel·SQLite를 통한 SHADOW/AIDE와 미전송 작성기, 최종 수정 후 차단 |
| 동기화·패키지 | graph·GRADIA channel·SDK pin 확인, 문서 링크, manifest/checksum 정합성 |

```bash
node --test PROGRAM/tests/libra_memory_graph_corpus_test.cjs PROGRAM/tests/libra_memory_graph_review_boundaries_runtime_test.cjs PROGRAM/tests/libra_memory_graph_incremental_currentness_runtime_test.cjs
node --test PROGRAM/tests/libra_memory_graph_selective_index_test.cjs PROGRAM/tests/libra_memory_graph_query_test.cjs PROGRAM/tests/libra_memory_graph_compiler_test.cjs PROGRAM/tests/libra_memory_graph_consumers_test.cjs PROGRAM/tests/libra_memory_graph_rollout_test.cjs PROGRAM/tests/libra_memory_graph_patch_contract_test.cjs
node --test PROGRAM/tests/libra_memory_graph_corpus_runtime_test.cjs PROGRAM/tests/libra_memory_graph_semantic_runtime_test.cjs PROGRAM/tests/libra_unified_search_replacement_runtime_test.cjs PROGRAM/tests/libra_memory_graph_patch_runtime_test.cjs
node --test PROGRAM/tests/libra_gradia_unified_pipeline_runtime_test.cjs PROGRAM/tests/libra_input_writer_unified_native_runtime_test.cjs
node PROGRAM/tools/sync_libra_memory_graph.cjs --check
node PROGRAM/tools/sync_libra_gradia_unified_read.cjs --check
node PROGRAM/tools/check_sdk_sync.cjs
```

## 4. 다음 작업과 남은 보장

다음 우선 구현은 **N01-C: source부터 최종 출력까지 실제 자원 counter·admission·backpressure**다. index payload 선택적 읽기, 일부 witness/frontier·private readset 예산이 있다는 사실과 전체 VM 자원 상한은 다르다. 저장 access의 진행 cursor·분할 재조립 예산과 semantic page 접근도 이어서 다룬다.

N01-A의 미소비 본문 raw tampering·native ABA와 server_only source 본문 읽기 감소, N02의 native 정본 global 이외 표현 정책/producer, N05 실제 원자적 GC, N06 고정 평가·실제 provider·설치/규모 인증은 남아 있다. N03/N04 연결과 N07 기본·유일 unified 전환은 이미 구현한 범위로 유지한다. 구체적인 선행 조건·완료 기준은 [잔여 과제](LIBRA_UNIFIED_MEMORY_ENGINE_NEXT_TASKS_20261014.md)를 따른다.

## 5. `f8fce44` 리뷰와 후속 수정

### 5.1 외부 작업자 평가

이번 7개 커밋만을 근거로 평가한다. 모듈·fixture·계약 문서를 빠르게 추가하고 N00의 퇴역 포맷 발송 격리, 표현 verdict 우선 검사, 구축 동등성 테스트를 보강한 점은 유효하다. 반면 요청 경계를 넘는 상태 수명과 실제 저장 schema 검증이 부족했다. mock owner 계약을 native 기능으로, 작은 합성 fixture의 통과를 품질 완료로 확대하는 경향이 나타났다.

| 평가 항목 | 이번 작업에서 확인한 근거 | 판단 |
| --- | --- | --- |
| 개별 구현·테스트 작성 | cursor/reassembler·GC 계약·평가 runner·소비자 분리의 빠른 추가 | 구현 작업을 수행할 역량이 있음 |
| 통합·수명 설계 | 공개 요청 간 staging 소멸, budget stop의 active scope 누락, 정상 checkpoint decode 실패 | 요청·저장·취소 경계 검증이 취약함 |
| 반증과 완료 판단 | 기대 필드 미검사, 무효 ablation, native fence/선택 읽기 완료 표기 | 별도 리뷰 없이 통합 완성 판정을 맡기기 어려움 |

권장 작업 방식은 과제 하나마다 **실제 등록 API의 성공·거부 경로, 변경 전 실패하는 반증, 자원/권한 종료, 구현된 범위와 남은 범위**를 함께 제출하는 것이다. 테스트 개수나 모듈 이름을 완료 근거로 쓰지 않는다. 이 평가는 관찰한 산출물에 관한 것이며 작업자의 동기나 모델 전체의 능력을 단정하지 않는다.

### 5.2 변경 전 재현과 수정

| 결함 | `f8fce44` 재현 | 후속 수정 |
| --- | --- | --- |
| P1 · budget stop 자원 누락 | 실제 API `maxStoragePages:1` 반환 뒤 retained 예약 9,551,620B·세션 1이 남고 cancel 후에도 동일. 물리 heap 측정이 아님 | readRows의 모든 중단/오류에서 요청 scope 해제. staging은 별도 제한·만료 ledger로 예약 |
| P2 · 요청 간 재개 불가 | 동일 generation의 다음 공개 API 호출에서 `STORAGE_CURSOR_INVALID` | runtime private 일회용 continuation. query/view/access·root/index 결속, TTL/개수/byte 한도, 완료·실패·취소·만료 정리 |
| P2 · 정상 checkpoint GC 실패 | `limit:1,maxWindowsPerStep:1`의 258,159B checkpoint로 dry-run/실행 모두 `RECORD_SIZE_INVALID` | corpus 전체 보존에 불필요한 body decode 제거. 실제 삭제 차단 유지 |
| P2 · 평가 기대값 무시 | UME-01에 틀린 outcome·존재하지 않는 family를 넣어도 PASS | 선언된 expected/passCriteria 검사, 각 check 보고·미지원 criterion 거부 |
| P2 · 무효 ablation | sealQueryFrame이 ablationMode를 버리고 그래프 확장, raw 후보와 bundle 비교 | kernel에서 실제 lexical-only signal 절제. 같은 view/시점·consumer의 admitted bundle 비교, graph-only/vector-only 반증 |
| P2 · 과도한 완료 표기 | native fence adapter/SDK/server 변경 없이 N05 완료, 전체 vector hydration 유지한 채 선택 읽기 완료 | 현황·다음 과제·평가/GC 계약을 실제 연결 범위로 정정 |

### 5.3 재개 수명과 보장 범위

staging에는 완료 행과 아직 조립 중인 조각만 보관한다. 공개 cursor는 opaque key·결속 metadata뿐이며 원문·owner verifier·readset·발송 권한을 전달하지 않는다. 기본 60초, 최대 16건, 건당 보수적 retained 추정 16MiB·전체 64MiB이며 runtime 공통 pool에도 계상한다. 정원·byte 부족은 거부한다. 동일 query/view/access에서 한 번 소비하며, runtime 재시작·root 변경·만료·취소·unload 후 재개하지 않는다.

실제 API budget stop 후 남는 예약은 reachable staging만이다. 세 저장 모드의 등록 API에서 다음 요청을 충분한 예산으로 재개해 전체 질의와 같은 bundle items를 확인했고, 완료/취소 후 예약·세션 0을 확인했다. 별도 kernel 검사는 새 corpus reader에서 저장 행 재개·eager 동일성·정원·만료·root 변경·재시작 거부를 확인한다. 전체 frontier를 영속화한 검색 세션이나 매 요청의 작은 예산만으로 완주를 보장하는 프로토콜은 아니다.

### 5.4 검증 명령과 한계

```bash
node --test PROGRAM/tests/libra_memory_graph_selective_index_test.cjs PROGRAM/tests/libra_memory_graph_corpus_test.cjs PROGRAM/tests/libra_memory_graph_query_test.cjs PROGRAM/tests/libra_memory_graph_store_lifecycle_gc_test.cjs PROGRAM/tests/libra_unified_memory_evaluation_test.cjs
node --test --test-concurrency=2 PROGRAM/tests/libra_memory_graph_review_f8_runtime_test.cjs PROGRAM/tests/libra_memory_graph_resources_runtime_test.cjs PROGRAM/tests/libra_memory_graph_review_boundaries_runtime_test.cjs PROGRAM/tests/libra_memory_graph_semantic_runtime_test.cjs PROGRAM/tests/libra_gradia_unified_pipeline_runtime_test.cjs PROGRAM/tests/libra_input_writer_unified_native_runtime_test.cjs PROGRAM/tests/libra_memory_graph_selective_runtime_test.cjs PROGRAM/tests/libra_memory_graph_corpus_runtime_test.cjs
node PROGRAM/tools/evaluate_libra_unified_memory.cjs
node PROGRAM/tools/sync_libra_memory_graph.cjs --check
node PROGRAM/tools/sync_libra_gradia_unified_read.cjs --check
node PROGRAM/tools/check_sdk_sync.cjs
```

검증 결과: 위 영향권 커널/정책 묶음은 Node runner 13/13, native·소비자 묶음은 25/25 PASS였다(semantic 파일 내부 8개 검사는 별도 출력). 새 실제 API 회귀 6개, 합성 fixture 8/8과 선언값·signal 절제 반증도 통과했다. graph/channel 동기화·SDK pin 확인 및 source 배포물 구문 검사를 통과했다. source build의 역사적 크기 기준 초과는 reporting-only이며 자원 상한 인증이 아니다.

합성 평가는 8개 fixture와 실제 kernel 절제 대조다. UME-02의 owner 창 순회, UME-04의 자율 정정 판단, UME-07의 실제 provider 장애를 증명하지 않는다. UME-05는 future/분기/private 실제 반례를 포함하도록 보강했다. 실제 provider·설치 RisuAI·지원 규모 인증은 미완료다. native 표현 선택 읽기·owner fence/다계층 회수도 다음 과제이며 전체 엔진 완료로 보고하지 않는다.
