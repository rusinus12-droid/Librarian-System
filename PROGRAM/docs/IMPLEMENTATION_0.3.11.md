# Librarian System 0.3.11 구현 보고서

## 구현 범위

0.3.11은 0.3.10의 저장 의미, namespace, owner schema, RE:TRACE 원본 불변 handoff를 바꾸지 않고 다음 병목과 LIBRA 추론 안정성 문제를 보강한다.

- 서버 key 목록과 `get-many`의 무제한 응답 방지
- 대형 단일 interactive JSON의 이벤트 루프 점유 방지
- Compute lower-lane 기아와 역방향 interactive 기아 동시 방지
- RE:TRACE 서버 스코프 관리 GUI의 전량 DOM 렌더 방지
- Flashback·HAYAKU·LIBRA JSON 백업·복원 stringify/parse의 메인 스레드 부담 완화
- LIBRA 정본·SGA의 물리 호출, 시간, 입력·출력·추론·총 토큰 전역 예산
- ito의 분리된 문법/구조 복구를 단일 authoritative repair로 통합

## 1. Storage Protocol 1.9 / SDK 1.8.13

### Key pagination

새 SDK는 `/v1/kv/keys`를 기본 400개, 최대 1000개의 prefix-bound cursor page로 순회한다. cursor에는 namespace·space·literal prefix가 결속되므로 다른 조회에 재사용할 수 없다. `%`, `_`, `\\`가 포함된 prefix도 SQL wildcard가 아니라 literal prefix로 처리한다.

구 SDK가 `paged=1` 없이 요청하면 종전 무페이지 응답을 유지한다. 따라서 0.3.11 서버에 구 플러그인을 연결해도 즉시 API 형식이 깨지지 않는다.

### Batch-read byte budget

새 SDK의 `/v1/kv/get-many`는 기본 4 MiB, 최소 256 KiB, 최대 8 MiB 응답 예산과 continuation을 사용한다. 서버는 SQLite의 `value_bytes`를 먼저 확인하므로 예산보다 큰 단일 record를 `JSON.parse`하기 전에 `oversizedKeys`로 분류하고, SDK가 그 key만 개별 GET으로 읽는다.

구 SDK의 무페이지 batch read가 기본 4 MiB 예산을 넘으면 서버는 413을 반환한다. 이는 큰 데이터를 삭제하거나 잘라내지 않으며, 무제한 `JSON.stringify`로 서버 이벤트 루프를 오래 점유하는 요청만 차단한다.

### Interactive value soft cap

SDK와 서버는 단일 interactive mutation이 약 4 MiB를 넘으면 명시적 오류로 거부한다. owner 데이터는 자동 변환하지 않는다. 큰 정본·packet·archive·vector는 기존 owner의 shard/manifest 구조를 사용해야 한다.

## 2. Compute scheduler aging

기존 `interactive → background → maintenance` 우선순위와 namespace round-robin을 유지한다. 기본 15초 이상 기다린 lower lane은 다음 빈 slot에서 제한적으로 승격될 수 있다. aged dispatch 직후에는 strict lane 우선순위를 한 번 강제해, lower-lane 기아를 막는 기능이 interactive 기아로 뒤집히지 않게 한다.

scheduler 통계는 lane별 `oldestWaitMs`와 `agingThresholdMs`를 노출한다. 실행 중 job을 선점하지 않는 기존 계약은 유지한다.

## 3. GUI와 portable JSON 처리

RE:TRACE 서버 데이터 관리 화면은 전체 inventory·선택 상태를 메모리에 유지하면서 DOM에는 60개 스코프만 렌더링한다. 이전/다음 페이지로 이동하며, 화면 밖 카드는 `content-visibility:auto`로 레이아웃과 페인트를 지연한다.

LIBRA 실행 결과·프롬프트·모델 원문 블록은 48,000자를 넘으면 12,000자 미리보기만 즉시 렌더링한다. 전체 본문은 사용자가 details를 열 때 `guiLazyDetails`가 한 번만 hydrate하며, 복사 기능은 미리보기가 아니라 완전한 원문을 사용한다.

Flashback·HAYAKU·LIBRA의 portable JSON 백업·복원은 가능한 환경에서 Blob Worker가 `JSON.stringify`/`JSON.parse`를 수행한다. stringify 결과는 UTF-8 `ArrayBuffer`로 변환해 transferable로 전달하므로 큰 문자열을 메인 스레드에 한 번 더 복제하지 않는다. Worker 생성·전송·시간 제한 실패 시 기존 동기 경로로 되돌아가며, 잘못된 JSON 자체는 성공으로 취급하지 않는다.

## 4. LIBRA 추론 예산

LIBRA 2.2.8은 정본과 SGA 실행에 전역 governor를 적용한다.

- 단계별 물리 호출 최대 2회
- 전체 wall deadline
- 누적 input/output/reasoning/total token hard limit
- 단계별 usage receipt
- 다음 호출 전 보수적 input estimate와 15% 안전계수
- 응답 후 provider-native usage 우선 정산
- 남은 reasoning 예산을 남은 물리 호출 slot으로 나눈 단계별 fair-share clamp
- Provider Manager식 `inputTokens/outputTokens/thinkingTokens/cachedInputTokens/totalTokens` usage 직접 정산
- provider-native total이 없을 때 OpenAI completion 내부 reasoning을 total에 이중 합산하지 않는 파생 정산
- budget 소진 시 마지막 검증된 정본·초안 보존

기본 정본 예산은 활성 단계 수에 따라 다음과 같이 고정된다. 사용자 override가 있으면 해당 값이 우선한다.

| 활성 단계 | Profile | Input | Output | Reasoning | Total | 최대 물리 호출 |
|---:|---|---:|---:|---:|---:|---:|
| 1 | light | 60,000 | 12,000 | 12,000 | 84,000 | 2 |
| 2 | balanced | 120,000 | 24,000 | 24,000 | 168,000 | 4 |
| 3 | balanced | 180,000 | 36,000 | 36,000 | 252,000 | 6 |
| 4 | heavy | 220,000 | 42,000 | 48,000 | 300,000 | 8 |

SGA는 예상 물리 호출 수에 비례하되 input 260,000, output 72,000, reasoning 60,000, total 380,000을 기본 상한으로 사용한다.

비용은 provider별 단가가 사용자 설정과 시점에 따라 달라지므로 이번 릴리스에서 금액 hard cap으로 계산하지 않는다. 토큰·호출·시간을 강제하고 usage를 남기는 범위다.

## 5. 단일 recovery ledger와 ito authoritative repair

정본/SGA의 capability, context, transient 오류 복구는 논리 호출별 한 번의 corrective 권한을 공유한다. 내부 ProviderBridge의 중첩 retry를 끄므로 cache/thinking/native JSON/context/transient fallback이 연쇄적으로 물리 호출 수를 늘리지 않는다.

ito는 다음 순서를 사용한다.

1. 초기 patch 후보 1회
2. 실패 이유 전체를 포함한 authoritative repair 1회
3. 그래도 실패하면 직전 유효 draft 보존

authoritative repair에는 JSON parse, schema, block hash, edit 적용, no-op/무효 edit 진단과 현재 권위 hash가 함께 들어간다. optional ito 실패 때문에 Ariadne 또는 앞 단계의 유효 정본이 사라지지 않는다.

## 6. 호환성

- Server 0.3.11 / Storage Protocol 1.9 / SDK 1.8.13
- Compute Protocol 1.1 / SDK 0.3.3
- Flashback 1.0.14
- HAYAKU 3.0.26
- LIBRA 2.2.8
- LIA 0.26.59
- RE:TRACE 1.9.65

기존 DATA layout 1, DB schema 1, plugin key/schema, immutable-source handoff, receipt schema는 유지한다. 강제 재분석·packet 재생성·재임베딩·Persona 재생성은 필요하지 않다.

## 7. 검증 범위와 한계

자동 검증은 구문 검사, SDK 내장본 parity, 서버/SDK 통합, key pagination·batch budget·soft cap, scheduler aging, LIBRA budget/repair의 정적·런타임 검증, 대형 결과 lazy hydration, portable JSON Worker 계약, RE:TRACE GUI pagination, 저장·복구·handoff 회귀를 포함한다.

실제 사용자의 RisuAI Tauri 프로세스와 개인 장기 DATA를 연결한 Chrome Performance trace는 이 패키지 제작 과정에서 수행하지 않았다. 따라서 실제 렌더 시간은 RisuAI 버전, 채팅 크기, 장치, 동시에 열린 GUI와 모델 호출 수에 따라 달라질 수 있다.

## 8. 최종 자동 검증 결과

Node.js 22.16.0 환경에서 `PROGRAM/tests`의 138개 CJS 회귀를 번호 1~138까지 새 로그로 다시 실행했다. 결과는 **138 PASS / 0 FAIL / 0 TIMEOUT**이다. 저장·복구·원본 불변 handoff, 4-namespace Compute 부하와 Worker matrix, GUI 비차단 계약, portable JSON Worker, LIBRA provider budget 런타임, 대형 결과 지연 hydration, Storage Protocol 1.9의 400/1000 key pagination과 4 MiB 기본 batch budget까지 포함한다.

시험 전후 비교에서 `program-manifest.json`과 `SHA256SUMS.txt`처럼 재생성 시각을 기록하는 산출물을 제외한 프로그램 소스 219개는 변경되지 않았다. 이후 manifest와 checksum을 최종 문서 상태로 다시 생성하고 data-layout 검증을 통과시킨다.
