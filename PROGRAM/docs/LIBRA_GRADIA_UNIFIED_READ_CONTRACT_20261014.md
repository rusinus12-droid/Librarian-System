# GRADIA의 LIBRA 통합 메모리 읽기 계약

- 작성일: 2026-10-14 · 버전: 1.0
- 범위: [다음 과제 N03](LIBRA_UNIFIED_MEMORY_ENGINE_NEXT_TASKS_20261014.md)의 실제 공급자 연결. 통합 엔진 전체 완성이나 설치 호스트 인증은 아니다.

## 사용 방법과 지원 범위

LIBRA와 GRADIA를 함께 로드하고 기존 LIB 서버 읽기 전용 연결 조건을 갖춘다. GRADIA 자료 화면에서 **LIBRA 검색 → 통합 메모리 검색**을 선택한 뒤 **연결**을 누른다. 선택은 연결할 때 적용한다. 공개 `connectUnifiedLibReadOnly(url)`도 같은 경로를 실행한다. 연결 성공 후 상태의 `readSource`는 `unified_engine`이다. URL별로 저장한 연결 동의에 출처도 보존한다. 이전 설정의 출처 기본값은 `server_logical_read`다.

현재 지원 조건은 **server_only**, 수락된 data identity/reset, 등록된 동일 character/chat scope, GRADIA의 실제 readonly 서버 권한, 인증된 plugin channel이다. 기존 G2 모델·문맥·payload 예산 제한을 유지하므로 연결 성공만으로 모든 생성 모델이 지원되는 것은 아니다. 현재 고정 profile은 `gpt-4o-mini-2024-07-18`의 허용된 요청 형식이다. plugin_only/mirror 또는 호스트 채널이 없는 환경을 같은 지원 범위로 주장하지 않는다.

연결/점검은 서버 권한과 통합 공급자 가용성을 검사한다. 실제 검색은 새 응답 실행에서 제출된 최신 사용자 입력을 질의로 실행한다. 채널의 질의 한도는 UTF-8 16 KiB, 직렬화된 요청 한도는 64 KiB이며 초과 요청을 거부한다. 점검 화면의 서버 원문 개수를 통합 검색 결과로 표시하지 않는다. GRADIA 인풋 작성기는 [N04 별도 세션 계약](LIBRA_GRADIA_INPUT_WRITER_READ_CONTRACT_20261014.md)으로 같은 공급자를 읽는다. 셰도우 세션을 재사용하지 않는다.

## 실제 실행과 권한

1. `runPipeline → openLibEvidenceRun → LibReadConsumer.beginRead`가 봉인한 source·scope와 최신 입력을 readonly SDK에 넘긴다.
2. SDK는 기존 서버 bootstrap의 readonly 역할·readNamespaces·writeNamespaces와 route·connection·data/reset을 확인한다. 서버 capture에서 검증된 **proof 메타데이터만** 권한 witness로 보관하고 current를 통합 공급자 호출 전후에 확인한다. 서버의 기존 검색 결과를 통합 결과로 선택하지 않는다. 새 요청은 낡은 witness를 새로 얻을 수 있지만, 이미 실행 중인 초안의 witness를 갱신해 계속 전달하지 않는다.
3. `libra.gradia-unified-read.v1` 요청은 RisuAI plugin channel로 전달한다. LIBRA는 호스트가 인증한 `metadata.sender === serial_gradation_agents_for_rp`만 허용하고, GRADIA는 `sender === libra`의 응답만 수락한다. payload의 sender 이름이나 공개 `__LIBRA__` 객체는 권한이 아니다. bearer token은 채널로 보내지 않는다.
4. LIBRA private owner는 활성 native scope, server mode, URL·data/reset·connection generation·restore/store 경계를 확인한다. 실제 `executeMemoryGraphUnifiedQuery`에 `consumer: gradia`, `viewerId: gradia_reader`와 private 발급 영수증을 결속한다. 정본·Micro·State·로어북은 기존 공통 scorer/frontier에 참여하며 private unit의 owner 전용 view를 빌려주지 않는다.
5. owner의 영수증과 실제 실행/검증 핸들을 private 메모리에 보관한다. compiler의 `validatePacket`가 원본과 현재 graph를 다시 검증한 결과만 발급한다. 공개 query API나 JSON에 복사한 digest만으로 새 권한을 만들 수 없다.
6. GRADIA는 owner가 선택한 typed packet 전체를 **하나의 atomic evidence item**으로 읽는다. 기존의 비신뢰 인용 근거·모델 문맥/토큰 예산·완전한 item 선택·최종 현재성 검사를 그대로 거친다. 네 단계는 한 번 캡처한 세션을 공유하고 단계마다 새 검색을 실행하지 않는다.

HAYAKU·Flashback을 함께 읽는 경우 LIBRA만 통합 엔진을 사용한다. 나머지는 각자의 기존 서버 읽기를 유지하고 `engine.sourceByOwner`에 기록한다. 결합 세션의 전역 corpus/raw/metadata 예산과 owner별 현재성 검증은 유지한다. LIBRA 없는 결합 세션은 통합 검색 요청을 수락하지 않는다.

## 근거·현재성·수명

응답은 `memory-suite.libra-read-session.v1`과 기존 proof/current 봉투를 사용한다. `source: unified_engine`, generation, owner corpus digest, selection receipt, `queryComplete`, `deliveryOutcome`, `windowRead`, `nextWindow`를 함께 보존한다. `complete:true`는 발급한 bundle을 완전히 캡처했다는 뜻이다. 미독 projection window가 있는 검색을 전체 corpus 완료로 바꾸지 않는다.

item의 `libra.unified.bundle:<receipt>` key는 이 실행에서 발급한 bundle 식별자다. durable 원본 주소로 해석하지 않는다. 원래 출처·시간·State 역할·충돌·로어 역할은 compiler packet에 보존한다. 내용이 prompt 예산에 맞지 않으면 전체 item을 거부하고 중간을 자르지 않는다. 빈 결과는 기존 무근거 흐름을 따르며 서버 검색으로 대체하지 않는다.

현재성은 원본 물리 readset, private 영수증, server readonly 권한, native 입력/설정, source·scope·연결·route·data/reset을 함께 검사한다. 변경이 확인되면 진행 중인 근거·초안과 후속 모델 전달을 차단한다. 정상 종료·무효화·취소·연결 해제·unload에는 영수증을 해제한다. 통신 불능 시 owner 메모리의 영수증도 최대 10분 유효기간으로 차단하며 다음 요청 때 정리한다. 활성 capture와 receipt 합계는 최대 32개다. 개별 채널 요청은 10초, 기존 consumer의 읽기 작업 제한은 30초다. 모든 단계의 무제한 실행 시간을 보장하지 않는다.

읽기 요청은 원본 정본/Micro/State·로어를 쓰지 않으며 분석/응답 helper를 시작하지 않는다. 설정된 native semantic adapter가 필요하면 기존 query embedding/cache 정책은 적용될 수 있다. 문서 임베딩 생산이나 역사 재분석을 읽기 중에 시작하지 않는다. 외부 근거와 파생 초안은 GRADIA 저장·이전 실행 재사용 대상이 아니다.

## 구현·동기화

- 공통 채널·영수증 factory: `tools/libra_gradia_unified_read.cjs`.
- 내장 재생성/검사: `node PROGRAM/tools/sync_libra_gradia_unified_read.cjs [--check]`.
- owner 연결은 `plugins/LIBRA.js`의 private `LibraMemoryCore`에 둔다.
- GRADIA의 `preserved-readonly-three-owner` SDK에 필요한 읽기 확장만 적용하고 `tools/lib/sdk_variants.cjs`의 검토 pin을 갱신한다. 공통 writer SDK로 대체하지 않으며 LIA·RETRACE pin을 유지한다.
- LIBRA 전용 SDK는 인증된 server binding에 reset epoch/certification을 추가한다. 토큰은 반환하지 않는다.

## 검증과 남은 제한

- `libra_gradia_unified_read_owner_test.cjs`: 실제 채널 factory의 발급·위조 proof·인증 sender·경계 변경·취소·해제·disconnect 검사.
- `gradia_three_owner_sdk_test.cjs`: 실제 GRADIA 내장 SDK의 owner별 출처·서버 권한 철회·새 요청만 witness 갱신·대기 중 route 변경 차단.
- `libra_gradia_unified_pipeline_runtime_test.cjs`: 실제 LIBRA native producer/kernel·SQLite·GRADIA 공개 연결 API와 beforeRequest를 결합한다. 한 검색이 SHADOW/AIDE 네 요청과 최종 전달로 이어지고, 원본 메모리 쓰기·추가 분석 모델 호출·근거 영속화가 없는지 확인한다. 후속 실행 중 원문을 수정하면 다음 단계와 최종 초안을 차단한다.
- 기존 source 계약, readonly 연결, 서버 adapter, 세 owner pipeline, 원본 교체, Classic·퇴역 회귀 검사를 유지한다.

N03 최초 연결(`e4ef853`)에서 위 세 신규/확장 suite의 23개 검사와 기존 영향권 검사 묶음의 99개가 통과했다. source 계약 파일 내부의 18개 판정과 native semantic 회귀의 8개 시나리오도 모두 통과했다. 두 플러그인의 source 빌드·구문 검사와 SDK/graph/channel 내장 동기화 검사를 수행했다. 빌드의 기존 크기 기준 초과 경고는 성능 인증으로 해석하지 않는다. 후속 작성기 검증은 N04 계약에서 추적한다.

호스트 채널과 모델 응답은 제어된 fixture다. 실제 설치 RisuAI의 채널 호환·성능, 외부 모델 답변의 의미 품질, 대규모 workload는 미인증이다. 검색은 현재 native projection window의 범위로 제한된다. 전체 corpus의 durable 인덱스·공통 캐시/Memory Lane(N01), 자료별 나머지 representation(N02), 안전한 native GC(N05), 품질/설치 인증(N06), 기본값 전환(N07)은 별도 과제다.
