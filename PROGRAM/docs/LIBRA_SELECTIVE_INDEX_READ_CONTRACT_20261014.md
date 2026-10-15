# LIBRA 공통 인덱스의 선택적 저장 페이지 읽기

- 작성일: 2026-10-14 · 갱신일: 2026-10-15 · 버전: 1.3
- 기준: `9c03c35` 이후의 N01 증분, `1aa630e` N01-A 증분 원본 현재성 검증 및 N01-B 증분 구축·재개·대형 단일 행 분할. 기본·유일한 통합 검색 계약은 유지한다.
- 판정: **신규 게시 인덱스는 검색에 필요한 저장 페이지만 읽고, N01-A owner 증분 증명으로 변경되지 않은 과거 구간 본문 재읽기를 생략하며, N01-B로 증분 구축·체크포인트 재개와 대형 단일 행 분할(`libra.graph_corpus_row_chunk.v1`)을 연결했다. 전체 VM 자원 계상(N01-C)과 실제 설치/규모 인증은 여전히 남아 있다.**

## 1. 실제 경로와 단일 탐색

이전 구현은 query가 시작되기 전에 directory·adjacency·postings·reverseDependencies 전체를 읽어 배열로 복원했다. 이제 corpus manifest를 열 때 frame·generation·표 metadata와 페이지 directory를 검증하고 private lazy index를 발급한다. 키워드·대상·시간/서술어 seed와 활성 frontier가 Memory Lane에 작업을 넣으면 해당 키 범위를 포함하는 저장 페이지만 비동기로 읽는다. 단일 행이 `pageBytes`를 넘어 여러 페이지로 분할 저장된 경우(`ref.splitRow`)에는 선택적 읽기가 해당 분할 그룹의 연속된 페이지들을 함께 읽어 `rowDigest`를 검증한 뒤 재조립해 반환한다.

Query와 Lane의 동기/비동기 driver는 같은 generator 본체를 실행한다. 점수·우선순위·강한 경로 재평가·종료·coverage·Compiler를 복제하지 않는다. in-memory/cold source 검색과 과거 manifest는 같은 알고리즘을 사용한다. 새 별도 순위 계산·legacy fallback은 없다.

신규 manifest는 `routingVersion: libra.index_page_routing.v1`과 각 page ref의 `routing`을 가진다. postings는 channel별 term 범위, adjacency는 anchor 범위, directory는 node/source 범위, reverse dependency는 dependency key 범위다. 범위가 겹치는 페이지를 모두 읽고 기존의 정확한 행 필터·offset·page admission을 적용한다. 범위가 넓어 생기는 추가 읽기는 허용하지만 임의로 첫 페이지/최근 자료만 선택하지 않는다.

페이지 directory는 namespace/key·digest·offset 연속성·행수(`rows`·`physicalRows`)·표 전체 count·크기·routing 형태·분할 행(`splitRow`) 연속성을 확인한다. 실제 읽은 페이지는 UTF-8 byte·내용 digest·행수와 재도출한 routing을 대조한다. metadata의 schema/tokenizer/partition/generation·indexDigest도 확인한다. 미지원 routing version은 거부한다. routing이 없는 이전 manifest는 전체 표 복원 경로로 읽으며 query가 저장소를 자동 변환하지 않는다. 다시 구축한 인덱스부터 선택적 읽기를 사용한다.

## 2. Cache Manager와 물리 접근 예산

검증한 원문/decoded 표의 별도 Map cache를 만들지 않는다. 모든 payload는 공통 Cache Manager의 reserve·install/acquire·pin/decode·release를 거친다. 한 요청의 첫 사용은 warm cache가 있어도 실제 저장값을 읽어 검증한다. 같은 요청에서 같은 immutable 페이지를 다시 쓰면 Cache Manager에서 재획득한다. 축출되면 재읽기도 다시 계상한다. 요청에는 검증한 page key의 작은 Set만 보관한다.

I/O 전에 예상 raw/hash workspace를 예약하고, 받은 문자열의 크기·digest를 확인한 뒤 JSON을 parse하기 전에 encoded token/byte 상한으로 decode workspace를 예약한다. 취소·late I/O·route/복원/삭제·cache 무효화·실패에는 모든 lease와 reservation을 해제한다. 비동기 Lane 실행 중 겹치는 step/drain/finalize는 거부한다. 취소된 late page는 실제 access 결과로 게시하지 않고 미독 cursor를 보존한다.

| 예산 | 기본값 | 허용 범위 |
| --- | --- | --- |
| `laneBudget.maxStoragePages` | 같은 요청의 `maxPages`(기본 64) | 1–512 |
| `laneBudget.maxStorageBytes` | 같은 요청의 `maxBytes`(기본 262,144) | 512 B–8 MiB |

두 예산은 실제 저장 page payload 접근의 admission이며 기존 논리 Lane page/byte 예산과 별개다. 한 access에 필요한 페이지를 다 읽을 예산이 없으면 그 access를 완료로 게시하지 않고 `lane_storage_page_count_budget` / `lane_storage_byte_budget`, partial과 미독 cursor를 반환한다. 현재 storage 중단은 그 access를 재시도하며 별도 disk cursor를 만들지 않는다. 큰 단일 posting/access에는 더 큰 명시적 예산이 필요할 수 있다.

`corpusRead.storage`는 `publishedPages/Bytes`, `pagesRead/bytesRead`, `uniquePagesRead`, `cacheHits`, `storageAccess`를 보고한다. `accessTrace.lane.storage`는 요청의 물리 예산과 사용량을 보고한다. bytes는 검증한 index JSON payload byte이며 HTTP header/envelope·원본 읽기·전체 heap byte가 아니다. shared cache의 accounted resident/request/staging과도 구분한다.

## 3. 검증 권한과 전체 점검

검색에 사용하지 않은 저장 페이지는 읽지 않는다. 따라서 무관한 페이지의 손상까지 각 query가 발견한다고 주장하지 않는다. 사용한 페이지의 오염은 warm/재시작에도 거부한다. 캡처한 root가 await 중 교체되면 거부하며, 최종 private 원본 검증에서도 root·route를 재확인한다. 저장 관련성 자료가 사실 권한이 되지 않도록 기존 native graph·물리 readset·embedding/settings·scope/worldline/view 검증은 유지한다.

등록 API `verifyMemoryGraphCorpus({expectedScopeKey?})`와 GUI 진단의 **전체 인덱스 검증**은 모든 표와 tableDigest·현재 원본 generation을 읽기 전용으로 대조한다. 미게시/손상/변경은 거부하며 repair·build·문서 embedding·분석 모델 호출·원본 쓰기를 하지 않는다. 성공 DTO는 `libra.graph_corpus_audit.v1`, `modelDispatchEligible:false`이고 owner의 전체 atomic snapshot이나 전체 corpus coverage 인증이 아니다.

## 4. 검증 근거

- 순수 selective suite: 열기 시 table I/O 0, 필요한 posting/frontier만 읽기, eager와 점수·witness·bundle/packet digest 일치, cold/warm/축출/독립 runtime, 요청한/미요청 손상과 audit, 물리 byte/page admission·partial, pending I/O 취소·root 교체·동시 실행 거부·미독 cursor·자원 해제, 잘못된 directory/routing/namespace·과거 manifest 호환.
- 고정 160-unit fixture: 전체 복원은 23페이지·332,423 B, 선택적 query는 3페이지·48,952 B. source/host/provider가 제어된 커널 fixture의 index payload 측정이며 전체 요청 latency/heap/네트워크 성능 인증으로 사용하지 않는다.
- 등록 native suite: 실제 LIBRA writer·storage bridge의 기본 query 물리 key 읽기와 보고값 대조(46페이지·341,409 B 중 15페이지·113,532 B), 안 읽은 reverse table의 손상을 full audit에서 발견, model/provider 호출 및 원본 쓰기 증가 없음.
- 기존 corpus runtime 및 N01-A/N01-B suite: plugin_only/server_only, 첫 구간 밖 Micro, 미소비 정본 본문 미읽기 및 소비 레코드 물리 변조 거부, 증분 구축·체크포인트 재개·대형 단일 행 분할·재조립·변조 거부, 재시작·원본 교체 거부, native semantic/Classic의 동일 frontier, 64키 이하 다중 readset과 partial coverage.
- GRADIA native suite: 게시 index를 통한 기본 셰도우/AIDE·인풋 작성기와 최종 수정 차단. owner source/readonly SDK/영수증 계약을 바꾸지 않는다.

```bash
node --test PROGRAM/tests/libra_memory_graph_selective_index_test.cjs PROGRAM/tests/libra_memory_graph_selective_runtime_test.cjs
node --test PROGRAM/tests/libra_memory_graph_corpus_test.cjs PROGRAM/tests/libra_memory_graph_incremental_currentness_runtime_test.cjs PROGRAM/tests/libra_memory_graph_corpus_runtime_test.cjs PROGRAM/tests/libra_unified_search_replacement_runtime_test.cjs
node --test PROGRAM/tests/libra_memory_graph_pages_test.cjs PROGRAM/tests/libra_memory_graph_index_test.cjs PROGRAM/tests/libra_memory_graph_query_test.cjs PROGRAM/tests/libra_memory_graph_rollout_test.cjs
node --test PROGRAM/tests/libra_gradia_unified_pipeline_runtime_test.cjs PROGRAM/tests/libra_input_writer_unified_native_runtime_test.cjs
```

## 5. 남은 N01

N01-A에서 `FAMILY_CURRENTNESS_CONTRACTS`와 `verifyIncrementalSourceProofs()`를 도입해 변경되지 않은 과거 구간의 정본·Micro 본문 재읽기를 생략(`nativeReprojectionRequired:false`)하고, 소비된 readset의 물리 레코드만 발송 직전에 재확인하도록 연결했다. N01-B에서 증분 창 슬라이스 재사용(`incremental_reuse`), `maxWindowsPerStep` 체크포인트 재개(`checkpoint_resume`), 대형 단일 행 분할(`libra.graph_corpus_row_chunk.v1`) 및 재조립 검증을 연결했다.

다음 작업은 전체 자원·작업공간·I/O 바이트 예산(N01-C)이다. `ownerAtomicity:false`, `inventoryComplete:false`, 전체 API `byteBounded:false`는 유지한다. N02/N05/N06의 추가 representation·native GC·실제 설치/품질·규모 인증도 이어서 진행한다.


## 6. 증명 버전과 미측정 비용의 호환

원본 proof v2는 native 투영과 physical body baseline을 함께 캡처한다. v1 proof는 전체 native 재투영으로 읽으며, 선택적 **인덱스** 접근은 계속 사용할 수 있다. proof 버전 때문에 query가 자동 저장 repair/build하거나 레거시 검색을 실행하지 않는다. checkpoint의 owner 증명·payload 검증과 GC 삭제 차단은 [후속 리뷰](LIBRA_UNIFIED_MEMORY_ENGINE_REVIEW_20261015.md)를 따른다.

`owner_io_in_flight`는 누적 Lane payload byte와 다르다. owner의 실제 동시 버퍼 계측과 미측정 `write_barrier`는 null·missingMeasurements로 남긴다. 이 정정은 N01-C 전체 admission 구현을 뜻하지 않는다.
