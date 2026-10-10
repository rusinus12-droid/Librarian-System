# MemorySuite 0.3.29 — 통합 설계 3차 구현

작성일: 2026-09-06. **v1.1 설계의 N0–N3를 한 지원 경로에 연결한 C0/C1 개발 합본**이다. 전체 설계 141개 인수 항목 완료, 실제 RisuAI 호스트 인증, 외부 모델 의미 품질 검증본을 뜻하지 않는다.

## 기준과 구성

입력: `MemorySuite_0.3.28_INTEGRATED_IMPLEMENTATION_02.zip`.
입력 SHA-256: `bb2dfd6424e722ae3a53f825f71cf396665a468e6a3cd3f92a4b6dd095442493`.
설계: `MemorySuite_Integrated_Design_v1.1/plan.md`, `INTEGRATED_DESIGN.md`, `ENGINE_CUTOVER.md`, `WORLD_MANAGER_CONTRACT.md`.

결과 구성: MemorySuite 0.3.29 / LIBRA 2.3.36 / HAYAKU 3.0.51 / Flashback 1.0.32 / LIA 0.26.63 / RE:TRACE 1.9.67.
기능 수정은 LIBRA.js이다. 다른 네 플러그인은 .28과 바이트 동일하게 유지한다. 서버는 버전 메타데이터만 바꾼다.

## 실행 경로

`완료 5 U+A → 통합 Ariadne → 선택한 typed ito → 마지막 유효 finalArtifact → 본문·검색 projection → 정본 physical readback·활성화 → 로컬 State → 독립 embedding`.

기존 설정은 `legacy` 그대로 읽는다. **새 기본값을 몰래 적용하지 않는다.** 새 엔진은 `unified`, `unified_review`, `serial_review`를 제공한다. unified의 정상 분석은 Ariadne dispatch 1 / 자동 ito 0 / 별도 normal Observer 0이다. 나머지 두 모드는 기존 사용자의 enabled ito·Provider·프로필을 보존하면서 새 typed 보정 계약을 사용한다. 서로 다른 모델을 하나의 호출처럼 표시하지 않는다.

여기서 ‘1회’는 정상 성공한 기억 분석의 Provider 경계 dispatch 수다. 사용자가 따로 설정한 응답 Planner/GRADIA, 실제 RP 모델 호출, embedding 호출, 명시 재시도까지 1회라는 뜻이 아니다. Provider/호스트 내부의 실제 HTTP 재시도 또는 의미 성공률을 보증하지 않는다. 새 경로의 자동 canonical repair와 구형 분석 fallback은 실행하지 않는다.

## N0: 좁은 저장 안전 경계

현재 지원은 **plugin_only / 동일 저장소의 단일 LIBRA owner writer / main / 연속된 새 5턴**이다. 처음은 빈 정본 범위 T1–T5부터이며, 이후 이전 Head의 throughTurn·basis·ready 상태와 직전 local-State receipt가 맞아야 한다. 실제 대화가 10턴 이상 쌓였어도 수동 콜드스타트는 앞에서부터 순차 처리할 수 있다. T100 Head를 T1–T5의 이전 상태로 쓰지 않는다.

Job 시작 시 engineVersion, 원문, 이전 Head/Registry, worldline 저장값, 정본 참조 및 Provider/자료권한 설정 digest를 고정한다. 모델 await 중 저장 lock을 들지 않는다. 저장 직전 현재 source/scope/grant/basis를 다시 확인하며 기존 .28의 자기 CAS 수정·원문 동의 경계를 유지한다.

State 저장은 candidate tx → Registry/readback → Head/readback → receipt/readback이다. 같은 owner 내 짧은 쓰기 구간에서는 목표 바이트 lease를 사용하고 외부 수정값을 덮지 않는다. Head/Registry를 모든 원자적 다중키 DB로 만든 것은 아니다. 다른 iframe·탭·기기와의 원자 CAS는 없으며 이를 지원한다고 표시하지 않는다.

## N1: finalArtifact의 권위 일원화

새 schema는 `libra.canonical_artifact.v4`: entities, facts, stateBindings이다. fact는 고유 임시 ID, 영역, 주체/관계 대상, typed 값, temporalRole, certainty, 원문 인용, 의존 fact를 가진다. 모델이 scope/hash/승인 토큰/영구 ID를 발급하지 않는다. 새 결과는 최대 100 entity, 120 fact, 120 binding, JSON 120,000문자로 계약을 제한한다.

선택 ito는 `libra.fact_revision_patch.v1`의 add/replace/retract로 보정한다. baseArtifactDigest와 개별 expectedDigest, ID, field allowlist, source quote, dependency DAG, binding 재결속을 검증한다. 무효 패치는 통째로 반려하고 직전 유효 artifact를 유지한다. optional 실패만으로 정본을 없애지 않는다. Ariadne의 기본 산출물이 무효면 정본을 활성화하지 않는다.

최종 본문과 저장 artifact는 마지막 유효 단계에서 함께 만든다. 검색 projection과 State도 같은 artifact를 참조한다. 새 text를 또 다른 LLM으로 역추출하지 않는다. 구형 v3 text는 그대로 읽으며 최초 artifact로 일괄 재렌더링하지 않는다. GRADIA의 공용 문장 patch 함수는 바꾸지 않았다.

## N2: 통합 분석·리콜·파생 작업

통합 prompt에 인물/방향 관계/지식/세계/서사 기준을 함께 넣고 별도 Observer 전제와 문장-only 지침을 새 typed 계약으로 대체한다. 기존 Provider, 각 agent 프로필, 허용 lore/RAG 범위는 계속 사용한다. Job마다 선택 정책이 고정되며 저장 work에는 Provider 비밀값 대신 정책 digest만 남긴다.

정본 저장 전 embedding을 기다리지 않는다. 정본이 활성화되면 기존 sparse recall로 즉시 검색 가능하며 vector는 pending이다. embedding 실패는 retry_pending으로 분리하고 해당 후처리만 다시 시도한다. 모델/원문/채팅/활성 정본이 변한 뒤 도착한 vector는 새 정본에 연결하지 않는다. 임베딩 모델 변경에 따른 전체 재생성은 기존 명시 버튼 정책을 유지한다.

새 v4 발췌는 문장 window가 아니라 완전한 fact 단위다. 과거 소지 사실을 선택하면 같은 구간·같은 field의 마지막 진술도 함께 넣는 chronology closure를 적용한다. 예산이 부족하면 마지막 반전 사실을 뺀 채 옛 값만 남기지 않는다. ‘구간 내 마지막 진술’은 그 구간의 정보이지 모든 이후 시점의 현재값 선언이 아니다. 기존 char/token packing 내부에서만 선택하며 v3 발췌는 바꾸지 않는다.

## N3: 세계 의미·실패 범위·읽기

초기 typed 계약은 장소와 물리적 포함 관계, 관리자, 소유자/소지자/보관 위치/접근 권한 분리, 범위 규칙과 조건부 예외, 방향 관계, 인물별 명시 지식, 열린 문제/해결을 다룬다. 임시 entity를 runtime stable ID로 결속하고 모호한 identity는 pending으로 둔다. 표기는 integrated_evidence_checked이며 독립 모델 Entity Admission 승인과 다르다.

동일 source 순서에서 충돌하는 값, 순환 포함 관계, 불확실·전언·가정·회고, 누락된 current binding, 실패한 fact의 의존 State는 적용을 보류한다. 무관한 도메인은 부분 완료할 수 있다. 관련 상태가 불완전하면 Head를 전부 최신 확정값처럼 표시하지 않는다. 지식은 현재 additive이며 지식 철회/명시 clear의 완전 계약은 후속이다.

`unifiedStateReadProjection`은 이름·값 중심의 읽기 snapshot을 제공한다. `unifiedWorldReadContext`는 장소의 상위 경로·규칙·해당 장소의 조건부 예외를 반환하되 조건 충족 여부를 키워드로 판정하지 않는다. 이 helper가 옛 World Manager 전체 기능을 대체한 것은 아니다.

기존 BOOK_UX, 기억/인물/세계/서사 데이터 화면, Planner/GRADIA/Input Writer 및 .28 공통 비교 UI를 유지한다. 새 설정 카드와 파생 작업 재시도 버튼만 추가했다. 새 v4에서 구형 문장-only 수정, 과거 replay, native copy/RE:TRACE/portable 재결속, worldline 변경을 무조건 성공시키지 않고 지원되지 않는 진입을 차단한다. 새 v4가 있는 scope에서 legacy writer가 다음 새 구간을 덮어 쓰는 것도 막는다. 백업 보관·읽기를 금지하는 의미는 아니며, 이전 키의 전면 변환은 하지 않는다.

## 사용

기존 DATA와 플러그인 설정을 별도로 백업하고 분리된 시험 대화에서 검수한다. PROGRAM/plugins/LIBRA.js를 교체한다. 서버 합본을 쓰는 경우 서버 종료 후 PROGRAM을 교체하고 **기존 DATA는 그대로 유지**한다. 다른 네 plugin은 동일 bytes다.

LIBRA 기억 설정의 ‘기억 분석 엔진’에서 ‘통합 분석 · Ariadne 1회’를 선택하고 기존 설정 저장 버튼을 누른다. 선택 전문 검토는 ‘통합 분석 + 선택 ito 보정’에서 기존 ito 활성 상태를 사용한다. 자동 콜드스타트를 추가하지 않았으므로 기존 대화의 첫 분석은 기존 수동 콜드스타트/구간 실행을 사용한다.

통합 정본의 State가 pending이면 ‘통합 상태 적용 재시도’, embedding 실패면 ‘통합 임베딩 후처리 재시도’를 사용한다. 의미/identity/원문 변경 때문에 차단된 후보를 재시도가 임의로 승인하지 않는다. partial인 이전 State가 해결되지 않으면 다음 구간도 안전하게 보류한다.

새 v4 데이터 작성 이후 구버전 바이너리로의 단순 downgrade는 지원하지 않는다. 분리 시험 환경과 전환 전 백업을 사용한다.

## 검사와 제한

신규 다섯 시험 파일은 전체 배포 LIBRA.js를 로드하고 실제 public Job, 원문 동의, 저장 경계, State, 검색기, beforeRequest 주입기를 실행한다. 외부 Provider/nativeFetch 경계의 출력과 실패만 제어한다. 제품 처리 로직을 별도 모사한 시뮬레이터나 상수 PASS가 아니다.

- libra_unified_vertical_v1_test.cjs: 공개 5턴 경로, 정본/State/실제 recall/세계 읽기.
- libra_unified_fact_pipeline_v1_test.cjs: 세 ito의 replace/add/retract, optional 실패, 부재 근거, 전언, 충돌/의존 전파.
- libra_unified_fault_recovery_v1_test.cjs: noop/throw/readback 실패, source/Head/Registry/scope 변경, 로컬 State 복구, 연속 두 구간.
- libra_unified_recall_vector_v1_test.cjs: 실제 Classic 주입과 마지막 반환 fact, embedding 지연/실패/변경 후 응답.
- libra_unified_mode_cutover_v1_test.cjs: 기본 유지, 사용자 ito 설정 보존, engine 고정, legacy 혼합/승계 차단.

최종 전체 회귀 결과·ZIP 해시·재추출 검사는 외부 `MEMORY_SUITE_IMPLEMENTATION_03_REPORT_KO.md`와 evidence ZIP을 따른다. 시험 경계에서 올바른 JSON을 제공한 결과는 실제 모델의 의미 정확도나 속도 개선 증거가 아니다. 실제 RisuAI 브라우저/외부 모델/API 연결은 미실행이다.

남은 작업: 전체 old/new migration과 typed source-edit replay, State 의미 보정/clear, 다중 writer와 backend별 중단 복구, 모든 원문 증거 승계·GC, WM-01–16 전체 동등성, 완전한 ResponseContext, 실제 A/B/C·호스트 검수, 그 뒤 기본 전환과 unused remote 경로 퇴역. 다음 작업은 INTEGRATED_IMPLEMENTATION_PLAN.md에 기록했다.
