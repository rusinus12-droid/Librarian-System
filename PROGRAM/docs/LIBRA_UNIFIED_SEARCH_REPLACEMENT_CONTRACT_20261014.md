# LIBRA 레거시 검색 종료 계약

- 작성일: 2026-10-14 · 버전: 1.1
- 기준: `75d9805` 이후, 사용자의 “레거시 검색을 새로운 엔진이 완전히 대체” 지시.
- 판정: **통합 엔진을 기본·유일한 검색기로 전환하고 기존 serving 경로를 제거했다. 실제 설치/품질·대규모 성능 인증 완료를 뜻하지 않는다.**

## 실행 경로

정본·Micro·State·로어북은 같은 owner graph와 공통 index·page cache·Memory Lane·scorer/frontier·EvidenceCompiler로 검색한다. 임베딩과 lexical/entity/time/관계는 같은 후보 평가에 참여한다. Classic 회상·최종 주입, GUI 정본 검색, GRADIA 셰도우/AIDE·인풋 작성기의 LIBRA 읽기가 이 경로를 사용한다. GUI는 동일 엔진의 lexical/graph 검색이며 열람 중 provider 호출을 시작하지 않는다.

| 입력/상태 | 실제 처리 |
| --- | --- |
| 새 설치·출처/모드 누락 | `unified`, GRADIA LIBRA는 `unified_engine` |
| 저장된/요청한 `legacy`·`shadow` | unified로 정규화, `retiredSelection`에 이관 출처 기록 |
| GRADIA 이전 `server_logical_read` 동의 | 같은 승인 범위에서 unified source로 이관 |
| 알 수 없는 엔진 모드 | 거부 |
| 호환되는 현재 게시 corpus index | 저장 공통 표 복원·같은 검색 실행 |
| 저장 index 없음 | 모든 owner cursor 구간을 열거해 `request_local_corpus`로 같은 검색 실행 |
| 원본 변경 또는 이전 tokenizer 표현 | auto는 새 native corpus로 같은 검색. required는 불일치 거부 |
| 저장 손상·권한/route/reset 변경·취소 | 거부. Classic은 원래 요청, GRADIA는 해당 근거/초안 차단 |
| 명시적 window 조회 | 호출자가 정한 구간의 같은 검색. 구간/미독 영역 공개 |

cold/stale 검색은 저장 index를 자동 repair/build하지 않고 원본이나 문서 벡터를 생산하지 않는다. query embedding은 기존 허용 provider·cache 정책만 사용한다. 전 구간 열거도 기본 64구간·graph 4 MiB 등의 admission을 받는다. 상한을 넘으면 실패하며 첫 구간을 전체 검색으로 표시하지 않는다. 자료별 미지원·읽기 실패·Lane/출력 예산은 partial/coverage로 유지한다.

## 제거한 실행과 보존한 소유권

기존 catalog shortlist·블록 router·dense/sparse/RRF/MMR 별도 순위·Micro head corpus·A2 cache 준비·옛 Classic 최종 renderer와 debug 실행 API를 제거했다. 옛 LIBRA BM25 compute adapter도 등록하지 않으며 generic compute 진단 API는 `retired`와 빈 operation을 반환한다. 역사 distribution operation/fingerprint는 retired 메타데이터로만 남기며 로컬 실행 adapter는 없다. 자동 정본 채택 후 catalog/evidence-link 준비도 종료했다. 오프라인 비교 helper는 고정된 baseline DTO와 새 엔진을 비교할 뿐 옛 검색을 실행하지 않는다.

원본 자료·writer·backup/import·명시적 evidence/lore inspector의 저장 호환은 유지한다. 공통 lexical tokenizer는 원 단어와 보수적인 한글 조사 변형을 같은 posting에 넣는다. tokenizer version은 `libra.tokenizer.nfkc_ko_particle_v2`이며 이전 저장 index를 현재 버전으로 간주하지 않는다.

fresh local의 기존 기본 route는 native owner 전용 읽기 관찰로 확인하며 routing row를 만들지 않는다. native mirror는 서버의 물리 조건 검증을 유지한다. 외부 readonly source의 route·권한 요구를 완화하지 않는다. GRADIA는 여전히 server_only·기존 readonly 승인·인증 plugin channel이 필요하다. HAYAKU·Flashback의 별도 서버 읽기는 각 owner의 경로이며 LIBRA fallback이 아니다.

Classic의 열람 행·응답 context에는 실제 채택된 동일 bundle과 native memory ID/revision을 연결한다. context 재검증도 private Compiler를 거치며 public digest나 행은 발송 권한이 아니다. private corpus 검증기를 보관하는 UI context는 최근 4개로 제한하며 밀려난 context는 재검증을 거부한다. 실제 최종 packet의 현재성·출력 예산·원문 비변경 검사는 유지한다.

기존 RRF/MMR/gate·발췌 반경·순위 프리셋 제어는 설정 화면에서 제거했다. 통합 근거 수(`unifiedMaxUnits`, 기본 24·1–256)와 문자 예산이 실제 기본 Classic Compiler admission에 적용된다. 이전 설정 원본은 가져오기 호환을 위해 보존한다.

## 검증과 역사 테스트의 종료

`libra_unified_search_replacement_runtime_test.cjs`는 실제 기본 Classic, 명시적 local route/index/opt-in 없는 읽기, 이전 모드 이관, 첫 20턴 밖 Micro 도달, GUI 한글 검색, 빈 owner, 손상 시 base request를 확인한다. 옛 catalog/index key 접근을 예외로 바꿔 미접근을 검사하고 원본 bytes·provider 호출도 대조한다. 별도 corpus/semantic suites는 저장 표 재사용·source 수정·재시작·단일 semantic frontier를 검증한다. GRADIA native suites는 일반 `connectLibReadOnly()`로 셰도우/AIDE·인풋 작성기의 최종 전달과 원본 수정 후 차단을 확인한다.

퇴역한 BM25 product pilot/server integration, A2 runtime access, B1 Micro lexical, Classic provenance rescue의 전용 테스트는 현재 serving 계약에서 제거했다. 이전 구현/검사 근거는 `75d9805`까지의 git 이력에 남는다. 대체 검사는 공통 graph query/compiler·native semantic/corpus·replacement suites다. 다른 owner의 Memory Lane/compute, 현재 Classic·GUI·제품 퇴역/권한 검사는 유지하고 새로운 계약으로 갱신한다. 예전 oversized-first-row 렌더 예외를 수용 기준으로 남기지 않는다.

```bash
node --test PROGRAM/tests/libra_memory_engine_mode_test.cjs PROGRAM/tests/libra_unified_search_replacement_runtime_test.cjs
node --test PROGRAM/tests/libra_memory_graph_corpus_test.cjs PROGRAM/tests/libra_memory_graph_corpus_runtime_test.cjs PROGRAM/tests/libra_memory_graph_semantic_runtime_test.cjs
node --test PROGRAM/tests/libra_gradia_unified_pipeline_runtime_test.cjs PROGRAM/tests/libra_input_writer_unified_native_runtime_test.cjs
node --test PROGRAM/tests/libra_read_context_basic.test.cjs PROGRAM/tests/gradia/readonly-connection.test.cjs
node PROGRAM/tools/sync_libra_memory_graph.cjs --check
node PROGRAM/tools/sync_libra_gradia_unified_read.cjs --check
node PROGRAM/tools/check_sdk_sync.cjs
```

현재 검증은 제어된 등록 합성 호스트·실제 SQLite/HTTP storage·shipped plugin의 호출 경로다. N01의 신규 저장 index 선택적 접근은 [후속 계약](LIBRA_SELECTIVE_INDEX_READ_CONTRACT_20261014.md)에서 연결했다. 원본 증분 검증·전체 workspace/I/O 계상, N02 추가 representation 생산, N05 native 실제 삭제, N06 설치/품질·규모 인증은 남는다. 이 미완료가 옛 엔진을 선택하거나 중복 실행시키지는 않는다.
