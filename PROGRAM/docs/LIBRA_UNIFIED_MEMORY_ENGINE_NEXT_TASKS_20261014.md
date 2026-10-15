# LIBRA 통합 메모리 엔진 — 다음 과제와 완료 기준

- 작성일: 2026-10-14 · 갱신일: 2026-10-15 · 문서 버전: 1.8
- 현재 코드 확인 기준: `codex/libra-memory-network-20261013`, [`923580b`](https://github.com/rusinus12-droid/Librarian-System/commit/923580b)이후 원본 증명·GC 경계 패치와 N01-C1 원본/저장 읽기·JSON admission
- 관련: [통합 설계](LIBRA_UNIFIED_MEMORY_ENGINE_DESIGN.md), [현재 현황](LIBRA_UNIFIED_MEMORY_ENGINE_STATUS_20261014.md), [선택적 인덱스 읽기](LIBRA_SELECTIVE_INDEX_READ_CONTRACT_20261014.md), [레거시 검색 종료](LIBRA_UNIFIED_SEARCH_REPLACEMENT_CONTRACT_20261014.md)
- 판정: **기본·유일한 통합 검색기와 활성 소비자 연결은 구현됐다. 원본 증분 검증·구축 재개·대형 행 분할도 연결됐다. 원본 증명의 보장 확대, 전체 자원 계상·admission, 추가 semantic 표현, 안전한 native GC, 실제 설치·품질·규모 검증은 남아 있다.**

이 문서는 최신 잔여 과제의 기준이다. 이전 버전의 증분별 설명을 현재 상태로 다시 정리했다. 구현 이력과 당시 검증은 [현황 §12–23](LIBRA_UNIFIED_MEMORY_ENGINE_STATUS_20261014.md) 및 각 계약에 보존한다. N01-C1의 현재 범위는 [자원 예산 계약](LIBRA_RESOURCE_ADMISSION_CONTRACT_20261015.md)을 따른다. 이전 리뷰·패치 근거는 [2026-10-15 리뷰](LIBRA_UNIFIED_MEMORY_ENGINE_REVIEW_20261015.md)와 현황 §23을 따른다. 과제 정의 자체를 구현·검증 완료로 읽지 않는다.

## 1. 확인한 실행 범위

| 대상 | 현재 구현·검증 범위 | 남은 범위 |
| --- | --- | --- |
| 단일 검색 | 네 자료가 한 graph/index·scorer/frontier·Memory Lane·Compiler를 사용. 정본 저장 벡터와 질의 임베딩도 같은 평가에 참여 | N01의 접근 비용, N02의 표현 확장, N06의 품질·규모 검증 |
| 영속 인덱스 | 전체 owner cursor 구간 구축·저장·재시작 후 재사용. 신규 manifest는 필요한 저장 페이지만 읽음 | 원본 증명 범위 확대, 저장 access 진행 cursor·분할 재조립 자원 예산 |
| LIBRA Classic·GUI | 기본 통합 검색과 Classic 최종 전달 연결. GUI 열람 질의는 provider 호출 없이 같은 lexical/graph 경로 사용 | 실제 설치 검증, coverage·실제 채택·비용 표시 점검 |
| GRADIA 셰도우·AIDE | 기본 LIBRA source는 unified_engine. private owner 영수증과 readonly 권한을 거쳐 실제 단계·최종 전달 연결 | 지원 profile에서 실제 설치·성능 인증 |
| GRADIA 인풋 작성기 | 별도 미전송 제안 세션·작성 버튼·생성/번역·선택/편집·복사/전송 검증 연결 | 지원 profile에서 실제 설치·성능 인증 |
| LIBRA Planner·SGA·Input Writer | 제품 실행 함수·공개 API·호스트 등록 퇴역. 커널의 일부 역사 packet 포맷은 보존 | N00의 호환 포맷·권한 계약 정리. 제품 실행 복원은 과제가 아님 |
| 레거시 검색 | 기본·유일한 serving은 unified. 기존 shortlist/RRF/MMR·catalog/블록/Micro head 준비·이전 renderer 실행 제거 | 회귀 방지·실제 호스트 검증. 전환을 새로 구현할 필요 없음 |

GRADIA는 현재 **server_only·readonly 승인·동일 native scope·수락한 data/reset·인증된 plugin channel**이 필요하다. 현재 G2 허용 모델·요청 형식의 제한도 유지한다. LIBRA owner의 plugin_only/mirror 지원을 GRADIA의 지원으로 확대 해석하지 않는다. HAYAKU·Flashback의 별도 서버 읽기는 각 owner의 기능이다.

저장 인덱스가 없거나 auto 모드에서 원본/tokenizer와 맞지 않으면 같은 엔진이 전 구간을 request-local로 읽는다. 저장 손상·권한/route/reset 변경은 거부한다. query가 영속 repair·문서 임베딩을 시작하거나 레거시 검색으로 돌아가지 않는다.

## 2. 과제와 기존 미완료 항목 대응

| ID | 우선순위·현재 상태 | 남은 과제 | 기존 항목 | 선행 조건 |
| --- | --- | --- | --- | --- |
| N00 | P2 · 마감 점검 | 활성 소비자와 역사 packet 포맷의 권한·문서 정합성 | M09/M15 | 현재 퇴역 계약 유지 |
| N01 | P1 · 부분 구현 | 원본 증명 범위 확대, 총 자원 admission, 저장 access 재개·재조립, 선택적 표현 접근 | M02–M05 | 원본별 변경 증명·coverage 계약 |
| N02 | P1 · 정본 global만 연결 | Micro·State·lore 및 세부 표현의 생산·저장·선택적 접근 결정과 구현 | M06–M08 | 표현/producer 계약, 접근 최적화에는 N01 |
| N03 | 연결 완료 · N06 검증 남음 | 셰도우·AIDE의 실제 설치·지원 profile 검증 | M09/M10 | 현재 reader/영수증 계약 유지 |
| N04 | 연결 완료 · N06 검증 남음 | 인풋 작성기의 실제 설치·지원 profile 검증 | M09/M10/M15 | 별도 proposal 세션 유지 |
| N05 | P1 · owner 기능 필요 | 완전한 inventory와 publisher/build/reader 보호를 갖춘 native GC | M11 | storage owner의 원자적 fence·조건부 삭제 |
| N06 | P1 · 미완료 | 고정 평가 세트, 계수 평가, 실제 provider·설치 호스트·규모 인증 | M12/M14 | 평가 정의는 즉시 가능, 인증에는 해당 구현 필요 |
| N07 | 전환·실행 제거 완료 | 단일 엔진 계약과 설정/백업 이관의 회귀 방지 | M13/M15 | N06은 별도 미완료 |

N01-b의 원본/저장 읽기·일시적 JSON 처리 admission(N01-C1)을 연결했다. 다음 구현은 **N01-C2의 장기 보유 graph/index/representation·private readset 및 유지보수 admission**이다. N01-a는 현재 증분 증명의 보장 확대 과제로 추적한다. N06-a 평가 세트 정의는 먼저 준비할 수 있다. N03/N04는 이미 연결된 기능을 다시 만드는 과제로 잡지 않고 N06의 소비자별 검증 대상으로 관리한다.

## 3. N00 — 활성 소비자와 호환 포맷

- facade·public API·설정·GUI·백업 가져오기의 활성 소비자 목록을 Classic·GUI·별도 GRADIA와 일치시킨다. 옛 `planner/sga/input_writer` formatter 지원은 그 자체로 제품 실행/발송 권한이 아님을 명시한다.
- 기존 퇴역 검사를 유지하고 역사 포맷을 실제 제품 권한으로 받아들이는 통로가 있는지 점검한다. 이번 문서 확인만으로 신규 결함이 재현됐다고 주장하지 않는다.
- 구형 저장 키·원문·사용자 draft의 일괄 삭제나 퇴역 helper 복원은 포함하지 않는다.

**완료 기준:** 활성 목록·호스트 등록·runtime 권한 검사·문서가 일치하고, 옛 설정/백업/공개 API 입력으로 퇴역 실행이 재개되지 않는다. 현재 Classic·GUI와 역사 자료 읽기는 유지한다.

## 4. N01 — 전체 기록의 공통 영속 접근

### N01-a · 부분 구현 · 원본 증명의 보장 확대

`1aa630e`의 N01-A는 owner manifest/ref·registry·Micro pair/head/work·State/정정·호스트 lore를 대조해 변경되지 않은 구간을 재투영하지 않는다. 이번 패치는 **투영과 함께 캡처한 SHA-256 본문 baseline**을 `libra.source_proof_contract.v2`에 결속하고, 이후 capture에서 본문이 달라졌으면 게시를 거부한다. v1 게시물은 전체 native 재투영으로 읽으며 과거 baseline을 새 권한으로 사용하지 않는다. 채택·억제·연결 의존성의 본문은 최종 private 검증으로 확인한다.

**남은 범위:**

- manifest/ref/head가 바뀌지 않은 **미소비 원본의 직접 저장 변조**까지 증분 head 증명이 검출하는 것은 아니다. 저장 키별 강한 revision/digest·존재/tombstone 증명이 필요하면 SDK·서버·capability·readonly 권한·응답 예산까지 실제 연결한다. metadata-only proof API는 아직 없다.
- server_only는 여전히 모든 source key를 여러 64키 조건부 readset으로 캡처·검증하며 SDK가 본문을 읽는다. plugin_only의 미소비 본문 생략을 server_only의 같은 비용 절감으로 일반화하지 않는다.
- native 대화/로어·설정, scope·세계선·restore epoch·data/reset·route/connection은 자체 검증을 유지한다. 원자적 revision이 없는 경로의 A→B→A 감지는 보장하지 않는다. 여러 readset은 전체 원본 atomic snapshot이 아니다.

**완료 기준:** full-reread 대조와 동일 근거/현재성, 저장 모드별 실제 source I/O 감소, 변경·삭제/재생성·ABA·복원·viewer/시간·profile/route/data/reset·await 중 변경/취소/늦은 응답 검증을 갖춘다. 지원하지 않는 owner 범위는 재읽기 또는 명시적 partial/reject로 남긴다. manifest/cache hit·public DTO digest만으로 발송 권한을 만들지 않는다.

### N01-b · P1 · 원본부터 출력까지 자원 계상·admission — N01-C1 부분 연결

현재 `maxStoragePages/maxStorageBytes`는 **인덱스 JSON payload** 접근 예산이다. N01-C1에서는 실제 scoped source reader와 LIBRA SDK readset, corpus root/proof/projection/page 접근에 요청별 byte/read quota와 공유 I/O 예약을 연결했다. JSON 처리/분할 재조립은 공통 page 계층의 workspace 산식으로 미리 예약한다. 실패 latch·취소/late 응답 해제와 `resourceAccess` trace를 추가했다. [계약·실제 검증](LIBRA_RESOURCE_ADMISSION_CONTRACT_20261015.md)을 따른다.

**남은 N01-C2:** 장기 보유 graph/eligibility/semantic Map·index compile·vector hydration·private readset·반환/동시 처리, build/publication의 admission과 수명별 release다. 호스트 context/route bootstrap과 HTTP envelope/transport buffer를 포함한 bounded response/stream protocol도 증명이 필요하다. 현재 I/O 예약 peak나 JSON workspace 추정을 실제 네트워크/heap peak로 사용하지 않는다.

**작업:** 비용 범주별 counter와 admission/backpressure를 실제 읽기·할당 경로에 연결한다. 누적 전송량, 동시에 보유한 resident/staging, peak heap, 문자·token 예산을 분리한다. page cache 외 별도 무계상 full-array/cache 우회를 만들지 않는다.

**완료 기준:** cold/warm/축출/재시작·동시 요청·pending I/O 취소에서 budget 종료가 partial/reject·미독 범위로 드러나고 pin/staging이 해제된다. 미측정은 `null`과 사유로 표시한다. 지원 profile의 전체 상한을 증명하기 전 `byteBounded:false`를 유지한다.

### N01-c · P1 · 큰 단일 행과 저장 접근의 재개

N01-B는 큰 단일 행을 청크로 저장하고 digest·연속성을 확인해 재조립한다. 다만 읽기에서는 해당 그룹을 모아 큰 행으로 재조립하며, physical budget 중단은 같은 access를 재시도한다. 별도의 저장 페이지 진행 cursor는 없다. 청크 metadata 자체가 page에 들어가지 않는 경우는 계속 거부한다.

**작업:** 기존 분할 schema·digest·연속성 검증을 유지하면서 generation에 결속한 저장 진행 cursor와 재조립 staging admission을 index·Cache Manager·Lane·audit에 연결한다. 필요하면 별도 작업으로 나누되 상한을 제거하는 방식으로 해결하지 않는다.

**완료 기준:** page보다 큰 행과 access를 작은 예산으로 나누어 읽고 이어갈 수 있다. fragment 누락/중복/오염·root 교체·재시작은 감지하며 eager 대조의 점수·witness·근거가 같다. 도중 결과를 access 완료나 전체 coverage로 표시하지 않는다.

### N01-d · P1 · 증분 구축·취소 후 재개·게시

N01-B는 owner 증명으로 변경 없는 구간 projection을 재사용하고 `maxWindowsPerStep` 체크포인트로 이어받는다. 이번 패치는 유효한 owner 증명 없는 재사용을 막고 checkpoint payload digest를 확인한다. 최종 병합 그래프의 index compile과 전체 표 순회는 계속 수행하며, 같은 불변 page는 저장 시 재사용한다.

**작업:** 현재 구간 재사용·checkpoint·분할 기능을 바탕으로, 필요하면 역의존성에 따른 page/index metadata의 선택적 재컴파일까지 확장한다. tokenizer/DF/degree·semantic profile의 변경 범위를 다루고, 유지보수 checkpoint·재개 기준·root-last/CAS 게시·실패 복구를 정의한다. query의 자동 repair/문서 임베딩은 추가하지 않는다.

**완료 기준:** 중간 실패·취소·재시작 뒤 유효한 기준에서 재개하고, source 수정/삭제·동시 게시 때 이전 세대와 혼합하지 않는다. full rebuild와 index·질의·coverage 결과를 대조한다. owner가 삭제/tombstone을 증명하지 못하면 `unobservableRemoval`을 유지한다.

### N01-e · P1 · semantic 접근·관찰의 나머지 연결

정본 global 벡터도 현재 원본 rows에서 준비하며, native graph/표현의 전체 Map은 유지한다. N02의 representation 저장·directory·접근 작업을 공통 generation/Cache Manager/Memory Lane에 연결한다. GUI의 미독/예산 종료·출처/시점·실제 채택 표시가 동일 query 결과를 설명하는지 점검한다.

**완료 기준:** 자료별 독립 ranker/cache 없이 필요한 representation page를 접근한다. 선택하지 않은 표현을 모두 hydrate하지 않고, missing/foreign/stale/out-of-view 사유와 비용·coverage가 query·Classic·GUI·GRADIA에서 보존된다. 벡터 없는 자료도 같은 lexical/entity/time/graph 검색에 참여한다.

**N01 전체 완료 조건:** 전 구간 자료의 도달과 현재 구현된 선택적 index 읽기를 유지하면서 남은 비용·저장 access 재개·변경 증명 경계를 닫는다. `nativeReprojectionRequired`, `inventoryComplete`, `ownerAtomicity`, `byteBounded`는 각각의 증거 범위로만 변경한다. 한 항목의 개선으로 나머지 보장을 참으로 바꾸지 않는다.

## 5. N02 — 자료별 semantic 표현

현재 native producer는 **정본 owner global projection**뿐이다. Micro·State·lore는 `no_representation_producer_declared`로 semantic 신호가 없음을 밝히며 같은 엔진의 다른 접근으로 검색된다. 표현 identity의 viewer·taskPair·profileDigest 검사와 scorer의 격리 gate는 이미 연결됐다.

- 자료별 text unit·생산 주체·갱신/철회·권한·예산을 결정한다. Micro의 검증된 claim/source-only 구분, State의 확실성·정정/clear, lore의 revision/passage locator·tombstone을 보존한다.
- 필요한 family만 명시적 유지보수 producer를 구현한다. 모든 자료에 무조건 벡터를 만드는 것을 완료 기준으로 삼지 않는다. query·boot·load·자동 write를 역사 문서 임베딩 트리거로 바꾸지 않는다.
- source projection의 유사도를 개별 fact의 참/현재성으로 승격하지 않는다. profile/provider/model/dimension/metric/taskPair·본문 basis·viewer/as-of/세계선/복원 결속과 최종 vector/config 재검증을 유지한다.
- N01-e와 함께 표현의 저장·선택적 접근을 연결한다. semantic·lexical 결과를 별도 검색한 뒤 RRF로 합치지 않는다.

**완료 기준:** 각 family를 표현 지원 또는 의도적 vectorless로 명시하고 양성·누락·stale·foreign·과거/미래·viewer 불일치를 같은 scorer/frontier에서 검사한다. 지원한 producer는 실제 유지보수→저장→재시작→query→최종 검증 경로를 재현한다. 의미 품질·가중치는 N06의 평가로 판정한다.

## 6. N03 — GRADIA 셰도우·AIDE 연결

**연결 구현 완료, E4 미완료.** native unified query/compiler → private 영수증 → 인증된 channel → 고정 readonly SDK → SHADOW/AIDE → 최종 handoff를 제어된 등록 호스트·SQLite에서 검증했다. 기본 연결·이전 저장 source 이관도 구현됐다.

남은 일은 N06에서 실제 설치의 지원 profile을 검증하고 N01 변경 시 이 소비자의 currentness/예산 회귀를 확인하는 것이다. 원본·source·route/reset·권한 변경·영수증 위조·취소/늦은 응답은 근거와 draft를 무효화해야 한다. 공개 DTO로 권한을 대체하거나 GRADIA에 owner 쓰기 권한을 주지 않는다.

계약·지원 제한: [GRADIA 통합 읽기](LIBRA_GRADIA_UNIFIED_READ_CONTRACT_20261014.md).

## 7. N04 — GRADIA 인풋 작성기의 별도 통합 읽기

**연결 구현 완료, E4 미완료.** 명시적 작성 버튼의 RP/Novel 생성·번역과 선택/편집·복사/전송이 별도 `LibWriterReadConsumer`·operation·proposal hash·기준 native context를 사용한다. 미전송 제안은 `factAdopted:false`이며 셰도우 세션을 빌리지 않는다.

남은 일은 N06의 실제 설치 검증이다. N01 변경 후에도 입력/편집·연결/권한·원본 변경, 재생성·취소·늦은 응답, sendChat 권한 대기 중 변경에서 이전 draft 전달을 차단해야 한다. 선택·복사만으로 정본/State를 쓰거나 자동 입력 handler를 복원하지 않는다.

계약·지원 제한: [인풋 작성기 읽기](LIBRA_GRADIA_INPUT_WRITER_READ_CONTRACT_20261014.md).

## 8. N05 — GC와 수명주기

현재 native 실제 삭제는 `blocked_atomic_gc_unavailable`로 차단된다. mark/dry-run·root reread·개별 CAS만으로는 publisher/build/reader와 삭제 사이의 원자성을 보장하지 못한다.

**작업:** storage owner의 완전한 durable inventory, namespace fence, candidate 본문/루트 결속 조건부 삭제, 진행 중 build·게시·reader pin/lease 보호와 재시작/만료 정책을 구현한다. window graph store뿐 아니라 현재 corpus root/manifest/page·checkpoint·representation의 도달성과 참조도 명시한다. 구형 store GC를 새 저장 형식 전체의 sweep으로 간주하지 않는다.

**완료 기준:** mark 뒤 새 root/reader 시작, root에 아직 연결되지 않은 build, candidate 교체, 취소·재시작 경합에서 필요한 데이터가 삭제되지 않는다. dry-run은 쓰지 않고, 증명이 없으면 삭제를 계속 차단한다. owner 기능 부재를 현재 조회 권한 확대나 사용자 원본 삭제로 우회하지 않는다.

## 9. N06 — 품질·비용·실제 호스트

### N06-a · P1 · 평가 세트와 합격 기준 — 지금 정의 가능

네 자료 연결 질문, 첫 window 밖 기억, 고유명사/동의어/다국어, 정정·충돌·unknown, 현재/과거·세계선·viewer, mandatory lore, vectorless·provider 실패를 포함한다. gold evidence·허용/금지 근거·기대 partial/coverage·실제 채택을 고정한다. corpus 크기·질의 분포·동시성·장비/provider별 합격 수치를 측정 전에 정한다.

과거 엔진 비교는 보존된 동일 snapshot/baseline artifact 또는 격리된 역사 checkout으로 수행한다. 평가를 위해 현재 제품의 레거시 serving을 되살리지 않는다. 같은 자료·질의로 semantic/lexical/관계 신호 ablation과 계수 calibration을 수행한다. 현재 `calibration:unmeasured`는 평가 전 유지한다.

### N06-b · P1 · 실제 embedding provider와 규모 측정

제어 HTTP 벡터의 계약 검사를 실제 모델의 검색 품질과 구분한다. recall/근거 정확성·현재성 오류·partial, p50/p95 latency·peak memory·원본/인덱스 I/O·cache/pin·provider 호출/실패 비용을 지원 profile에서 측정한다. 선택적 인덱스 fixture의 감소량을 전체 latency/heap/네트워크 개선으로 보고하지 않는다. 기존 대규모 OOM/BLOCKED 기록의 제한은 유지한다.

### N06-c · P1 · 실제 설치 RisuAI 인증

Classic·GUI·GRADIA 셰도우/AIDE·인풋 작성기의 실제 발송/복사/전송, 취소·복원·원본/설정/권한 변경, 재시작·동시 요청을 확인한다. LIBRA owner 저장 모드와 GRADIA server_only 조건을 별도로 기록하고, 지원하지 않는 모델·호스트 채널·규모를 명시한다.

**완료 기준:** 구현 SHA, 실제 host/provider·설정·workload, 사전 합격 수치, raw 측정과 결과가 재현 가능하다. E1 커널·E2 등록 API·E3 합성 소비자 PASS를 E4 설치 인증으로 바꾸지 않는다. profile별 합격과 미지원 범위를 함께 공개한다.

## 10. N07 — 기본값 전환과 중복 경로 종료

`9c03c35`에서 기본·유일한 serving 전환과 기존 실행 제거를 수행했다. `legacy/shadow`는 출처를 기록하며 unified로 정규화하고, GRADIA LIBRA의 이전 logical source도 같은 승인 범위에서 unified로 이관한다.

**남은 유지 조건:** 설정/백업/재시작·진단/GUI 경로가 퇴역 helper나 옛 ranker·catalog 준비·중복 prompt 주입을 재개하지 않는다. cold/stale도 같은 엔진을 쓰고, 손상/권한 오류는 기존 실패 계약을 따른다. 품질·성능 인증은 N06이며 전환을 미구현으로 되돌려 표기하지 않는다.

## 11. 실행 순서·검증·종료 기록

권장 구현 순서는 **N01-b의 N01-C2 → N01-c/e**다. N01-a의 증명 확대와 N01-d의 선택적 재컴파일은 owner 기능·계측 근거에 맞춰 진행한다. N06-a와 N00 점검은 그 전에 시작할 수 있고, N02는 N01-e와 맞추어 진행한다. N05는 owner 기능을 먼저 구현·검증하고 삭제를 연결한다. N06-b/c의 최종 인증은 해당 변경이 고정된 뒤 수행한다.

기존 회귀 검사의 시작점은 다음과 같다. 아래 명령의 존재는 미래 증분의 완료 증거가 아니며, 이번 후속 패치의 실제 실행 결과와 재현 범위는 현황 §23 및 리뷰 문서에 기록한다.

| 변경 경계 | 기존 검사·기록 |
| --- | --- |
| N01 원본/영속 접근 | `libra_memory_graph_corpus_test.cjs`, `libra_memory_graph_corpus_runtime_test.cjs`, `libra_sdk_conditional_batch_v1_test.cjs`, `libra_memory_graph_inventory_store_test.cjs`, `libra_memory_graph_review_boundaries_runtime_test.cjs`, `libra_memory_graph_resources_test.cjs`, `libra_memory_graph_resources_runtime_test.cjs` |
| N01 index/cache/Lane | `libra_memory_graph_selective_index_test.cjs`, `libra_memory_graph_selective_runtime_test.cjs`, `libra_memory_graph_pages_test.cjs`, `libra_memory_graph_query_test.cjs`, `libra_memory_graph_rollout_test.cjs` |
| N02 표현/producer | `libra_memory_graph_representation_test.cjs`, `libra_memory_graph_producer_policy_test.cjs`, `libra_memory_graph_semantic_runtime_test.cjs` |
| N03/N04 소비자 | `libra_gradia_unified_pipeline_runtime_test.cjs`, `libra_input_writer_unified_native_runtime_test.cjs`, `gradia_input_writer_unified_runtime_test.cjs`, `libra_gradia_unified_read_source_test.cjs` |
| N05 게시/GC 경합 | `libra_memory_graph_store_test.cjs`, `libra_memory_graph_patch_contract_test.cjs`, `libra_memory_graph_patch_runtime_test.cjs` |
| N00/N07 전환·퇴역 | `libra_helper_retirement_runtime_test.cjs`, `libra_unified_search_replacement_runtime_test.cjs`, `libra_memory_engine_mode_test.cjs` |

모든 파일은 `PROGRAM/tests/` 기준이다. 실제 변경 경로에 맞는 양성·음성 대조를 추가하고, SDK/커널 변경 시 내장 코드 동기화와 고정 SDK pin을 확인한다. 배포 manifest/checksum도 갱신한다.

과제 마감 시 `ID·수정 커밋·실제 API/소비자 경로·정상/거부 검증·측정값·지원 profile·남은 한계`를 [현황 문서](LIBRA_UNIFIED_MEMORY_ENGINE_STATUS_20261014.md)에 기록한다. 전체 완성은 지원 profile에서 설계의 원본/시간/권한·저장/예산·단일 검색·소비자/최종 발송·품질/설치 gate를 증거로 충족할 때 판정한다. 미지원 native 프로토콜 때문에 불가능한 보장은 blocked로 공개한다.

## 12. `9a61245` 리뷰 후 네 결함 패치

이 절은 기존 링크를 보존하는 이력 요약이다. 통합 SDK의 provider 전후 route/reset/connection 검사, GRADIA readSource 봉인, representation의 viewer/taskPair/profileDigest 비교, source 내용 수정과 window identity 분리를 패치했다. 당시 직접 회귀는 세 파일 38개 검사였다. 이후의 실제 공급자·corpus index·선택적 접근·레거시 전환은 [현황 §16–20](LIBRA_UNIFIED_MEMORY_ENGINE_STATUS_20261014.md)에서 추적한다.

이전 버전의 “GRADIA unified 공급자 미연결”, “기본값 전환은 후속”, “미독 cursor 질의 도달 미구현”, “표 전체 hydration” 설명은 당시 증분의 한계이며 현재 잔여 과제가 아니다. 반대로 N01의 전체 원자성/총 자원 보장, N02 추가 producer, N05 실제 삭제, N06 E4 인증은 이번 정리로 닫지 않는다. N01-A/B의 구현 진척과 이번 안전 경계 패치는 §4 및 현황 §21–23을 우선한다.


## 13. 동기화 후 6개 스위트 재지정 (퇴역 전제 정리)

`25cbd13`을 로컬에 동기화한 뒤, **통합 전용 정책과 LIBRA owner 읽기 계약이 퇴역시킨 전제를 그대로 들고 있던 스위트 6개**가 실패하는 것을 확인했다(정책 커밋에서 어느 파일도 수정되지 않았다). 삭제 대신 새 정책으로 재지정했다.

| 스위트 | 퇴역한 전제 | 재지정 내용 |
| --- | --- | --- |
| `gradia_readonly_cross_project_test` | SQLite→서버 읽기→SDK→GRA | 픽스처 owner 읽기(`tests/fixtures/libra_owner_unified_read_provider.cjs`)가 같은 `memory-suite.libra-read-session.v1` 봉투로 서빙. SQLite 행 불변·operations 0·교체 후 초안 무효화는 유지하고, 서버 읽기 엔드포인트가 **근거에 전혀 쓰이지 않음**을 단언 |
| `review_readonly_worst_escape_test` | 32MiB NUL + 소형 항목을 서버 읽기로 | 같은 owner 읽기로 서빙. 선택/생략·예산 단언 유지 |
| `composed_reanalysis_gradia_runtime_test` | 위와 같음 + 정본 교체 | owner 읽기가 LIBRA 정본(`fx.getMemory()`)을 읽어 교체가 자연히 반영된다. tag-only 편집은 근거를 유지하고, 서버 읽기 미사용을 단언 |
| `gradia_three_owner_consumer_test` | 서버 읽기 클라이언트가 출처 미보고 | 응답 출처와 `engine.sourceByOwner`를 보고. **LIBRA=통합 엔진, hayaku·flashback=각자의 서버 읽기**임을 단언으로 고정 |
| `tests/gradia/server-read-adapter.test` | 두 픽스처가 출처 미보고 | 서빙한 출처를 보고 |
| `libra_memory_graph_patch_runtime_test` | legacy 선택 시 legacy rescue 실행(양성 컨트롤) | **음성 컨트롤로 전환**: 퇴역 선택은 unified로 이관되고 `retiredSelection: 'legacy'`로 공개되며 rescue는 0회. 변환은 앵커 존재를 스스로 단언해 컨트롤이 조용히 무의미해지지 않게 했다. 물리 원본 변경 거부는 엔진 자체 코드(`CORPUS_SOURCE_CHANGED`)도 수용 |

실측: 6개 통과(`three_owner_consumer` 6, `server-read-adapter` 50, `patch_runtime` 3, `cross_project` 1, `worst_escape` 1, `composed` 1). GRADIA·SDK 계열 9/9, 그래프·정책·표시·N03 계열 32/32, 게이트·체크섬 통과.

## 14. 전수 스윕과 귀속 (전체 회귀는 아직 이르다)

`tests/*.cjs` 전수(1,230개; 레포 배치 대상은 `*_test.cjs`/`*.test.cjs` 1,189개)를 스위트당 150초 제한으로 돌려 **646개까지 확인**한 뒤 중단했다. 기능 작업이 진행 중인 시점의 전체 회귀는 릴리스 관문이고, 지금 필요한 정보는 **귀속**이었기 때문이다.

**귀속 (레포 자체 배치로 검증)**: 실패군을 `main`(`a9549e05`, 브랜치 이전)과 현재 트리에서 **`run_regression_batch.py`로 각각 실행**해 비교했다. 원시 `node` 실행이 아니라 배치의 cwd·환경·타임아웃을 그대로 쓴 비교이며, 표본에서 원시 실행과 같은 결과가 나왔다(방법 차이 때문에 생긴 빨강이 아님).

| 스위트 | main | 현재 | 원인 |
| --- | --- | --- | --- |
| `compute_gui_and_libra_open_latency_contract_test` | PASS | **FAIL** | `MemorySuiteLibraComputeBridge`가 트리에서 사라짐(`9c03c35`). GUI 연결 패널은 여전히 `computeBridge`를 소비 |
| `compute_sdk_version_independence_test` | PASS | **FAIL** | 삭제된 `libra_recall_bm25f_compute_pilot_test.cjs` 참조 |
| `engine_consistency_v2_runtime_test` | PASS | **FAIL** | `debugBuildRecallBm25fInput` 제거(`9c03c35`) |
| `health_shared_owner_adapter_compatibility_test` | PASS | **FAIL** | LIBRA 캐시 repair가 현재 scope 캐시를 삭제하지 않음(다른 owner는 통과) |
| `gradia_three_owner_connection_test` | PASS | **FAIL** | connect·동의 계약 변경 |
| `gradia_three_owner_pipeline_test` | PASS | **FAIL** | owner·payload 계약 변경 |

**환경 클래스(main에서도 실패)**: `build_plugins_refusal_exit_test`는 macOS `/private/var` vs `/var` 경로 문자열 차이, `build_plugins_artifact_libra_readiness_test`는 빌드 산출물 디렉터리 전제조건 부재다. `authority_core3_runtime`·`authority_initial_qualification`·`authority_libra_source_closure`(`.test`)는 main에서도 실제 테스트가 실패한다(`AUTHORITY_QUARANTINED` 등). 즉 **이 머신에서는 main도 초록이 아니다** — 이 머신에 이전 배치 로그(`FULL_TEST_EXECUTION_LOG_*.txt`)가 없어 "main 전체 초록" 주장 자체를 로컬에서 확인할 수는 없었다.

| 뒤집힌 스위트 | 실패 형태 | 유형 |
| --- | --- | --- |
| `engine_consistency_v2_runtime_test` | `debugBuildRecallBm25fInput is not a function` | 퇴역 API 참조 (정책 stale) |
| `compute_sdk_version_independence_test` | 삭제된 `libra_recall_bm25f_compute_pilot_test.cjs`를 실행 | 퇴역 스위트 참조 |
| `compute_gui_and_libra_open_latency_contract_test` | `LibraMemoryCore must explicitly export its closure-owned Compute bridge` | export 계약 변경 — 확인 필요 |
| `gradia_three_owner_connection_test` | UI Connect·동의 v2 단언 실패 | 연결 흐름 변경 — 재지정 필요 |
| `gradia_three_owner_pipeline_test` | payload·owner 변경 단언 실패 | 읽기 경로 변경 — 재지정 필요 |
| `health_shared_owner_adapter_compatibility_test` | 34개 중 1개 (cache repair 범위) | 확인 필요 (실제 결함 가능) |

**추가 결함 (실측·귀속 확인)**: 모델 근거 블록에 내부 식별자·원시 JSON 누출.
`9a61245`에서 항목 0개·누출 0종 → 현재 24항목·7종 id 누출(`ce_person_02c035f3`, `ce_world_*`), 2개 항목은 내부 JSON 통째. 위치는 생성 `tools/libra_memory_graph_readers.cjs:251` (`text: JSON.stringify(items[itemIndex])`)와 전달 `tools/libra_memory_graph_compiler.cjs:266-278`. `libra_input_writer_phase06_authority_runtime_test`의 `doesNotMatch /ce_/` 검사가 이 결함을 잡으므로 **그 스위트는 의도적으로 빨강**이다(옛 문구 단언만 새 문장으로 갱신했고 누출 검사는 약화하지 않았다).

**메모**: `tests/*.cjs` 전체 스윕은 배치 대상이 아닌 도구·수동 하네스까지 실행한다(`apply_libra_phase06_from_baseline.cjs` code=2, `docs/gui-redesign/verification/...` 산출물 생성). 전체 회귀는 레포 자체 도구(`run_regression_batch.py`)로 릴리스 시점에 돌리는 것이 맞다.

