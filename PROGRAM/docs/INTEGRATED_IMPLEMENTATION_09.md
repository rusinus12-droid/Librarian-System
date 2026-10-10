# 9차 — Planner·GRADIA·Input Writer 개발 보강

2026-09-07 / MemorySuite 0.3.35 · LIBRA 2.3.42 · Storage SDK 1.8.15.
기준은 통합 설계 v1.8 및 8차 0.3.34 / 2.3.41이다. 이 문서는 코드 지원 범위다. 실제 실행 성적·고정 hash는 별도 9차 보고서/원본 로그를 따른다. 제품 차수9가 설계 P7/P8 운영 인증을 뜻하지 않는다.

## 유지

Librarian 단일 생성 `librarian / libra.unified.v2`, 정본 v4, 5 U+A 단위·원문 동의·local State/replay·Registry·교정·분기·RE:TRACE/portable·벡터와 제한 서버 경계를 유지한다. 퇴역된 기억 agent는 다시 실행하지 않는다. GRADIA 작성용 SHADOW/AIDE는 독립 기능으로 유지한다. 저장 schema·namespace·기존 기억을 재작성하지 않는다.

## 작성 공통 계약

`libra.response_consumers.v2`는 새 작성 요청/캐시 정책이다. 실제 자료를 읽은 때의 `libra.consumer_readset.v1`에 note/제공된 description·Persona/선택 lore와 선정 정책을 결속한다. 같은 자료를 실제 호스트 API로 다시 읽어 다음 생성·복구·채택·전달/삽입/전송에서 확인한다. 과거 digest를 현재값으로 복사하지 않는다. 사용되지 않은 description은 무효화하지 않으며 CBS 변수에 의존하는 자료는 해당 context를 확인한다. 조회 불명은 `CONSUMER_FRESHNESS_UNVERIFIED`다.

호스트에 개별 module reader가 없으면 허용된 database 필드/eligible inventory를 다시 읽는다. 일부 구형 codec에 본문 locator가 없으면 `eligible_corpus_without_body_locators`로 보호한다. 이는 매번 전체 pluginStorage 검색이나 모델 호출은 아니지만 모든 자료를 개별 O(1) 조회한다는 뜻도 아니다. 호스트 원자 snapshot·완전 ABA·다중 기기 무경합을 보장하지 않는다.

작성용 entity map은 짧은 request ID와 이름/별칭을 분리한다. 관계·소유·소지·위치·지식 등 참조를 같은 map에 연결한다. 원본 Head와 기억용 projection은 유지한다. 현 입력/장면/recall을 seed로 필요한 연결을 포함한다. 임의 자연어에 숨은 모든 관련 항목을 완전하게 선정했다는 의미 인증은 아니다.

선정된 필수 자료/완성 draft는 중간 절단하지 않는다. system/user/profile/Skill/draft/출력 여유를 포함해 문자 및 추정 token 예산을 점검한다. 필수 자료가 초과하면 생성 전에 보류한다. 실제 prompt hash·크기·선정/누락 metadata를 보존한다. 자동 요약·분할 생성은 없다.

## 호출과 오류

`libra.response_consumer_policy.v1`에 작업별 오류 추가0/1, 대기·요청 한도와 Planner 최종 언어 정책을 저장한다. Planner·입력 후보·번역의 새 기본은 오류 추가0. 명시적으로1을 저장한 작업만 동일 역할로 추가1을 허용한다. GRADIA 정상 단계/Writer/길이 보정은 오류 추가와 별도이며 전체 오류 추가0/1을 공유한다.

호출은 `taskKind`, normal slot, scope, input/정책·자료에 결속된다. 공용 Provider의 내부 복구가 별도 예산을 만들지 못한다. 모든 제어 가능한 transport 제출과 전체 usage를 합산하고 미보고 fields는 unknown/partial로 구별한다. final RP·embedding·호스트 내부 retries는 별개다. 네트워크 응답 불명/인증/거절/취소/자료 변경은 자동 형식 복구로 재제출하지 않는다.

OtherAx는 논리 취소와 실제 host promise 완료를 분리한다. 논리 취소 후 UI는 종료할 수 있으나 물리 호출의 큐 소유권을 유지하고 같은 group의 중복 제출을 막는다. 늦은 결과는 폐기하고 usage만 수집한다. 실제 host 취소가 되었다고 표시하지 않는다. 직접 Provider는 기존 transport timeout/abort와 operation 검사에 연결하며, host/provider가 보고하지 않는 model-only 시간은 null이다.

## Planner

현재 입력에 대한 자연어 반응 브리프1회·정상 캐시0회, 원자료 비노출·자동 Classic 대체 없음은 유지한다. 빈값/형식/절단/ID 누출을 차단하되 길이90/행수/행동·인과 단어는 진단이다. 짧은 타당한 브리프를 길이만으로 반려하지 않는다. 구조 검사 통과는 의미 정확성 인증이 아니다.

브리프 언어와 최종 언어를 분리한다. 새 기본은 host 언어, 기존 명시 Planner 언어 설정은 follow_brief로 호환하여 사용자 선택을 보존한다. 자료가 바뀐 결과는 보관하되 주입하지 않고 blocked/stale를 기록한다.

## GRADIA

경량1+A, 중량2×(1+A), Writer 선택+1, 필요한 길이 보정+1을 유지한다. 중량 private analysis와 본 작성은 동일 stage의 compiled profile·Skill·허용 자료를 사용한다. SHADOW-only note 원문은 다른 AIDE로 무조건 공유하지 않는다. 기존 잠금 전달을 재사용하며 자연어 note 전체를 자동 typed constraint로 인증하지 않는다.

신규 AIDE 출력은 `libra.sga_patch.v3`다. 기존 v2 문단 patch에 exact request binding token과 per-edit domain/actor/evidence/constraint/effect 연결을 추가한다. 잘못된 stage·token·참조·명시된 immutable constraint 변경은 반려한다. 문단 hash 원자 적용과 합법적 실제 수정·no-op는 유지한다. v2 reader는 역사/debug 호환이고 신규 생산 parser는 v3를 요구한다. custom 프로필의 구형 output 형식은 runtime 계약을 덮을 수 없다.

**의미 제한:** 모델이 sidecar에서 preserve라 하면서 본문에서는 뜻을 바꿀 수 있다. arbitrary prose의 사실성·비밀/동의 보존을 기계적으로 완전 검증하지 않는다. `naturalLanguageMeaning:not_certified`로 구별한다. 추가 Verifier LLM은 없다.

실패 AIDE의 원본 분석은 log에 보존하되 executable final guidance에서는 제외한다. 성공/no-op 채택 단계의 정상화 분석 전체는 보존하여 전달한다. Writer와 main transfer는 같은 accepted filter를 사용한다. stale/context 오류는 후속 호출/주입을 멈추고 기존 정상 초안을 진단에 남긴다. 일반 patch 실패는 기존 soft/degraded/hard를 따른다.

명시 Provider prefix cache를 새로 활성화한 것은 아니다. GUI는 현재 plugin-explicit disabled / 호스트 자동 여부 unknown을 사실대로 표시한다. 결과 cache는 새 readset/map/정책을 검증한다. 금지/가정/인용 movement cue는 optional Skill의 긍정 부스트를 억제할 수 있으나 의미 판단기를 대신하지 않는다.

## Input Writer·번역·전송

requested mode와 returned mode, 고유 ID, 정확한 author perspective를 검사한다. mode/root가 틀리면 전체 반려, 두 후보만 유효하면 partial로 보존하여 원문과 함께 명시 선택할 수 있다. 부족한 후보를 자동 보충하지 않는다. 후보가 구조 검사를 통과해도 원문 의도/사용자 주권이 의미적으로 검증됐다고 표시하지 않는다. source 비교와 최종 편집을 유지한다.

빠른/상세 설정 모두 독립 inputWriterMode를 사용한다. GRADIA Author+Input RP는 정상 조합이다. 번역은 정확한 선택 문장의 hash와 editor revision에 결속된 별도 작업이며 대기 중 수정/취소 뒤 늦은 번역이 덮어쓰지 않는다. 번역 결과의 fidelity는 실모델 미검수다.

copy/insert/send, cycle 중복 방지, send 준비후 재검증과 accepted_pending/readback을 유지한다. stale copy는 명시 경고와 함께 수동 복사 가능하지만 stale 자동 insert/send는 금지한다. 사용자 메시지는 들어갔으나 AI 응답만 실패한 경우 자동 재전송하지 않는다.

## 남은 검수

실제 RisuAI iframe·권한·IPC·OtherAx 물리 취소와 실제 모델 의미/비용/지연은 NOT_RUN이다. 본 차수는 실호스트 설치/네트워크 재시도를 실행하지 않았다. 311개 설계 인수조건 전체가 인증됐다는 뜻이 아니다. 모델 sidecar의 정직성, 모든 자연어 hard constraint, 관련성 선정의 완전성, 모든 CBS·module 권한 조합, prefix cache 성능은 별도 검수다. 기존 server/mirror/GC 미지원은 그대로다.
