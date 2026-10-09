# 통합 설계 구현 2차 — MemorySuite 0.3.28

작성일: 2026-09-06(KST). **개발 합본이며 P0–P8 전체 완료본이 아닙니다.**
기준: 0.3.27, SHA-256 `cd5576cd0c75ed37e9614e1b6095e714a7ce1762a415add57afb5f4ec2851da7`.

| 구성 | 버전 | 범위 |
|---|---|---|
| LIBRA | 2.3.35 | 원문 diff/선택, 승인 입력 보관, 비동기 상태 쓰기 기준 검증 |
| HAYAKU | 3.0.51 | 원문 diff/선택, 정상 패킷의 전체 U+A 증거 보관, scope별 복원 검사 |
| Flashback | 1.0.32 | 기존 실제 저장 본문으로 공통 원문 검토 UI/승인 계약 사용 |
| LIA | 0.26.63 | 기준 JS와 동일 |
| RE:TRACE | 1.9.67 | 기준 JS와 동일 |
| 서버/패키지 | 0.3.28 | 버전 metadata만 갱신; 서버 기능 확장 없음 |

## 1. 실제 변경된 기능

### 1.1 세 owner의 변경 전·후 원문 검토

`MemorySuiteSourceReview.source.js` 1.0.0은 세 플러그인의 자체 iframe 안에서 동일한 선택 의미를 제공합니다. 테마는 LIBRA의 책 색상, HAYAKU의 밝은 GUI, Flashback의 어두운 GUI로 각각 유지합니다. core를 공유하되 동의/작업/저장소를 전역으로 합치지 않았습니다.

LIBRA `reviewSourceEdits()`, HAYAKU의 Recovery Journal 확인 동작, Flashback의 기억 유지보수 확인 동작을 실제 review set→선택→승인→기존 owner 실행 경로에 연결했습니다. LIBRA의 기존 일반·진단 원문 수정 진입점도 같은 함수를 이용합니다.

LIBRA는 정확한 **5 U+A 문서** 단위, HAYAKU/Flashback은 **1 U+A** 단위입니다. LIBRA T2/T4가 함께 바뀌면 T1–T5 문서 단위로 두 수정 모두를 확인합니다. 전체 선택·전체 해제·개별 선택과 선택한 처리 개수를 제공합니다. 닫기·Escape·나중에·다른 scope로 이동은 승인하지 않습니다.

직접 수정과 선행 변경의 영향 가능성을 문구로 구분합니다. dependency 항목은 기본 미선택입니다. 선택한 dependency에 대한 기존 재분석 경로는 유지하며, 로컬 의존성 replay 최적화 전체는 P5에 남아 있습니다.

전체 이전/현재 비교용 본문을 표시합니다. 공통 앞뒤를 제외한 **하나의 변경 범위**를 강조합니다. 다중 hunk 최소 diff나 LLM 비교는 아닙니다. raw 전체 메시지를 실제로 보관한 경우에만 삽화·패킷 태그를 포함한 원문을 별도 펼침으로 표시합니다. HTML은 실행하지 않습니다.

긴 목록은 열린 비교 본문만 DOM에 만듭니다. 닫아도 선택은 유지되며 전체 선택은 현재 열린 문서에 국한되지 않습니다. 모든 review 원문을 네트워크로 보내는 기능은 없습니다. UI는 2초 간격 scope 관측으로 닫힘/이동을 처리하고, 승인/실행/저장 경계에는 별도의 정확한 원문 버전 검증이 유지됩니다. UI polling이 권한 검증을 대신하지 않습니다.

### 1.2 이전 원문이 없는 경우

LIBRA의 요약·근거 몇 줄 또는 HAYAKU packet JSON을 이전 채팅 원문으로 표시하지 않습니다. 이전 전체 본문이 없거나 손상되어 검증하지 못하면 기존 정본을 유지하고 별도 확인란을 보여 줍니다.

`이전 본문 없이 현재 원문으로 교체하는 것을 확인했습니다.`를 명시적으로 선택해야 그 항목을 처리할 수 있습니다. 전체 선택은 이 확인란을 대신 누르지 않습니다. 현재 원문 자체도 검증되지 않으면 별도 확인을 해도 실행할 수 없습니다.

업데이트만으로 과거 전체 원문을 복원할 수는 없습니다. 새로 확정되는 LIBRA 정본과 정상 HAYAKU 패킷부터 전체 입력 증거를 보관합니다. 이전 자료를 자동 재분석하거나 기존 text를 바꾸지 않습니다.

### 1.3 공통 승인 코어 1.2.0

세 `MemorySuiteSourceEditConsent` SDK를 같은 core로 동기화했습니다. 기존 1.1.0의 명시적 keys 검증에 review fingerprint·currentValid·이전 원문 부재 확인 키 검증을 더했습니다. 잘못된 review scope/행 개수/중복 키/누락 fingerprint/선택하지 않은 키는 거부합니다.

승인 UI를 표시한 set, 반환한 선택 keys, 실제 실행 unit이 일치해야 합니다. 미선택은 보류하며, JSON 원문 전체를 동의 journal/debug 요약에 중복 저장하지 않습니다. full source는 owner 증거 저장소에 남고 journal에는 식별자·해시·상태만 둡니다.

구형 generic SafeDOM fallback도 본문과 정확한 범위 및 이전 원문 부재를 표시하도록 보강했지만, 세 제품의 정상 검토 경로는 자체 iframe입니다. 권한 거부를 우회하는 호스트 DOM 호출은 추가하지 않았습니다.

## 2. 승인 입력의 증거 보관

LIBRA와 HAYAKU에 `memory-suite.source-evidence.v1` blob과 참조를 연결했습니다. owner/scope/unit/양쪽 메시지 ID/identity/sourceDigest와 전체 U+A 행을 결속합니다. 내용 fingerprint는 무결성·중복 확인용이며 인증용 암호학적 서명이라고 주장하지 않습니다. 같은 키의 실제 다른 내용은 비교 후 충돌로 거부합니다.

| owner | 저장 라우팅 |
|---|---|
| LIBRA | `libra:v1:scope:<scope>:source-evidence:v1:` |
| HAYAKU | `hayaku.v2.source-evidence.<scope>::` |
| Flashback | 기존 실제 U+A 저장소 재사용 |

같은 approved-input digest에서 삽화 등 raw 표현만 바뀌면 최초 raw 사본을 보존하며 비교용 본문은 동일한 것으로 읽습니다. 빈 ID·불완전한 5턴 범위·손상된 blob·저장 거부·readback 불일치를 성공으로 표시하지 않습니다. 저장 실패 시 새 정본/패킷 commit에 오류를 전달하고 기존 정본은 유지합니다. 큰 본문은 조용히 자르지 않고 용량 초과를 표시합니다.

scope resolver, portable/owner restore 검증, LIBRA canonical sidecar export에 증거 키를 연결했습니다. HAYAKU의 일반 owner storage 열거도 증거 prefix를 포함합니다. **이것은 모든 RE:TRACE 승계/아카이브/브랜치에서 과거 증거가 자동 재결속된다는 검증은 아닙니다.** 다른 scope의 증거를 현재 scope 자료처럼 쓰지 않으며, target에서 정확한 이전 원문을 찾지 못하면 명시적인 부재 검토가 됩니다. 보존/정리 정책의 완전한 통합은 후속 검수 대상입니다.

증거는 별도 기억 분석기·회상 엔진이 아닙니다. Flashback 설치가 LIBRA/HAYAKU의 전제도 아닙니다. 호스트 채팅에 원문을 재저장하지 않고, 기존 원문/정본을 삭제하는 migration도 넣지 않았습니다.

## 3. LIBRA 상태 분석 중 외부 변경 보호

1차는 reducer 내부 baseline과 working copy를 나누어 자기 CAS 충돌을 고쳤습니다. 이번에는 그 전 단계인 `runStateTrackingAfterCommit`에서 **모델 호출 전에** 저장 Head/Registry를 고정하도록 했습니다.

기존에는 모델이 응답한 뒤 저장 상태를 읽는 구간이 있어, 그 사이 다른 작업이 바꾼 값을 새로운 baseline으로 오인할 수 있었습니다. 이제 분석 시작 기준을 유지하고 Observer 전, Registry 저장 전, 최종 Head 저장 직전에 재검증합니다. 분석 중 Head가 달라졌는데 domain 실패 표기만 하고 오래된 working Head를 뒤에서 저장하는 경로도 차단했습니다.

자기 작업이 Registry를 저장한 경우에는 저장/재읽기 확인 후에만 예상 Registry 토큰을 갱신합니다. 최종 canonical envelope도 다시 검증하고, Head는 physical readback까지 확인합니다. 실패하면 원인 코드와 기존 정본/변경된 상태를 보존합니다.

**보장 범위:** 관측한 비동기 분석 구간의 최신값 덮어쓰기 방지입니다. pluginStorage에 원자 CAS API가 생긴 것은 아닙니다. 모든 writer의 통합 직렬화·다중 탭/기기·서버 동시 변경·의존 group 단위 적용·다중키 crash transaction의 전체 완료를 뜻하지 않습니다.

## 4. 유지한 기능과 아직 안 한 기능

정확한 5 U+A, 원문 수정 승인 전 기존 정본, 삽화 예외, 기존 단계별 모델/ito/Observer 설정, GUI 가족 선택과 Input Writer, HAYAKU 복구 검증/최소화, Flashback 원문 리콜을 유지했습니다. LIA와 RE:TRACE JS는 그대로입니다.

아직 **P3의 finalArtifact 일원화 및 구조화된 ito 보정, P4의 Ariadne 1회 기억·상태 통합 분석, 정상 Observer 제거, State/vector 후처리 분리**를 적용하지 않았습니다. 따라서 기존 ito 본문과 최초 Ariadne artifact가 달라지는 알려진 문제는 후속 구현 대상이며, 모델 호출 수·10분 지연이 이번에 해결됐다고 하지 않습니다.

## 5. 검증 방법과 한계

새 CJS 검사는 원문 blob의 소유권·범위·용량·충돌·readback, review 승인 범위, 실제 LIBRA/HAYAKU capture/교체, 모델 대기 중 Head/Registry 변경, export/restore scope 라우팅을 검사합니다. 새 브라우저 검사는 공통 DOM+승인 코어와 **세 전체 플러그인 JS의 실제 public 진입점**을 실행합니다.

전체 회귀 명령: `MEMORY_SUITE_REGRESSION_LOG=<PROGRAM 밖 경로> python run_regression_batch.py`.
동기화: `node tools/sync_source_edit_consent.cjs --check`, `node tools/sync_source_review.cjs --check`, `node tools/check_sdk_sync.cjs`.
개별 신규 검사와 브라우저 명령은 인계 문서에 있습니다. 최종 실행 수치와 초기 실패는 외부 보고서/증거 ZIP에 구분해 제공합니다.

RisuAI API·저장소·모델은 중립적인 시험 경계입니다. 실제 사용자 DB·외부 모델·RisuAI 설치·모바일 실기기·의미적 품질·지연 비교는 수행하지 않았습니다. 브라우저 owner 선택 시험에서 LIBRA state를 비활성화한 fixture는 선택한 canonical 호출 수를 분리해 보는 시험 조건이며, 제품의 state 설정을 변경한 것이 아닙니다.

## 6. 설치

개발 합본입니다. 기존 DATA/플러그인 설정을 백업하고 분리 환경에서 먼저 검수하세요. 서버 종료 후 **DATA는 보존하고 PROGRAM만 교체**합니다. RisuAI에서는 기존 LIBRA/HAYAKU/Flashback 항목을 업데이트하고 신·구 중복 활성화하지 않습니다. ZIP의 DATA는 신규 설치용 빈 구성입니다. 일괄 정본 재생성/벡터 재생성/강제 콜드스타트가 필요하지 않습니다.
