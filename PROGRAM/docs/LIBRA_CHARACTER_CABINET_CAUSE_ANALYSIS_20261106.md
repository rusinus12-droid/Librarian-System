# 인물 카드함 원인 분석 — 2026-11-06

## 조사 범위

사용자가 제공한 `C:\Users\rusin\Downloads\libra-debug-2026-11-06 (1).json`(LIBRA 2.6.36), 현재 `PROGRAM/plugins/LIBRA.js`, 로그와 일치하는 로컬 SQLite scope `bf8f10a0_11:4`를 대조했다. SQLite는 `DatabaseSync(..., {readOnly:true})`로만 읽었다. 첨부 로그의 마지막 provider 응답은 본문이 보관되지 않은 Micro 응답이며, 전체 분석 결과를 대신하는 자료로 사용하지 않았다. 로컬 저장 상태는 첨부 시점과 동일한 스냅샷이라고 가정하지 않았다.

이번 작업은 원인 조사다. 플러그인·기억 데이터·설정은 변경하지 않았다. 조사 전부터 존재한 LIBRA.js 변경과 `.development/`, 재분석 대기 테스트 파일은 유지했다.

## 1. 현재 위치에 내부 ID가 표시되는 원인 — 재현 확인

문제 ID `ce_world_87c91f6f`는 **거실**이다. T4 Micro 승인 기록의 `patch.microNewEntities`에 해당 ID와 이름이 존재하며, 세연의 `locationRef`를 그 ID로 설정하는 패치가 `admitted / still_current`로 저장되어 있다. 반면 현재 영속 Registry와 정본 State에는 이 장소가 없다.

`projectActiveMicroStateForResponse`에는 두 경로가 있다.

- 정본 이후의 Micro 처리 경로는 `patch.microNewEntities`를 `registryView.entities`에 추가하고 `retainMicroLocationReference`를 호출한다.
- 정본 턴 범위와 겹치는 승인 Micro 처리 경로는 `microEffectiveEntityId`로 기존 정본 항목과 연결할 수 있는지 확인하지만, 정본에 같은 장소가 없을 때 패치의 새 항목을 이름 조회 목록에 추가하지 않는다. 이후 `retainMicroLocationReference(head, registry, ...)`는 영속 Registry에서만 이름을 찾다가 반환한다.

결과적으로 인물의 위치 ID는 다시 반영되지만 장소 이름을 가진 세계 항목은 읽기 모델에 없다. `worldManagerDisplayReferences`는 `view.characters / view.world`에서 이름을 못 찾으면 원래 ID를 반환한다.

현재 소스의 두 함수를 직접 추출하여 실제 승인 패치·Registry·State를 입력한 최소 재현 결과:

```text
패치의 새 장소를 Registry 조회 목록에 추가하지 않음 → ce_world_87c91f6f
같은 조회 목록에 검증된 patch.microNewEntities를 추가 → 거실
```

최소 재현은 참조 보존 및 표시 함수를 실행한 것이며, 실제 RisuAI 전체 화면 재실행은 아니다. 수정은 겹침·상속 등 참조 복원 경로에서 승인 패치가 제공한 식별 정보를 함께 전달해야 한다. 미확인 참조를 원시 ID로 표시하는 fallback도 별도 개선 대상이다.

관련 코드: `microEffectiveEntityId` 약 58660행, `retainMicroLocationReference` 60624행, 겹침 경로 60760~60870행, 이후 턴 경로 60937~61003행, `worldManagerDisplayReferences` 90198행.

## 2. 소개·선호·경계가 비는 원인 — 추출 결과에 항목 부재 확인

확인한 정본은 `mem_000001`(T1~5), `mem_000006`(T6~10)이다.

| 정본 | 저장된 사실 종류 |
|---|---|
| T1~5 | event 11, character_state 3, knowledge 3, relationship 4, containment 1, thread 1 |
| T6~10 | event 10, character_state 2, knowledge 1, location 1, relationship 1, thread 1 |

두 정본 모두 외형·배경·성격·말투·습관·능력 및 선호·경계 유형의 사실은 **0개**다. 현재 영속 State의 네 인물에도 이 필드들은 없다. 같은 scope의 저장된 Micro 분석 22개(재분석 이력 포함)를 확인해도 해당 필드의 State intent는 없었다. 따라서 이 표본에서는 저장된 해당 필드를 카드가 숨기는 현상보다 **분석 결과가 해당 항목을 만들지 않는 현상**이 먼저 확인된다.

카드는 전체 기억 문장으로 소개를 새로 쓰지 않는다. 소개는 `appearance/background/personality/speech/habits/abilities`, 선호는 `preferences`, 경계는 `boundaries` 필드만 표시한다. 사건 기록이 늘어도 이 필드로 추출되지 않으면 채워지지 않는다. 분석 프롬프트는 해당 사실 추출을 요구하지만, 누락된 분야가 있다는 이유만으로 결과 전체를 실패 처리하거나 자동 보완하는 것은 아니다. `characters.status=ready`도 모든 소개 항목의 충실도를 보증하지 않는다.

일부 근거는 별도로 검증에서 제외되었다. 예를 들어 T1~5의 f3(개인정보를 팔지 않겠다고 선을 긋는 내용)는 인용이 원문과 일치하지 않아 `UNIFIED_EVIDENCE_REQUIRED:f3 / source_quote_mismatch`로 제외되었다. 이것은 보존할 만한 내용도 인용 오류로 사라질 수 있음을 보여준다. 다만 이 사실이 원래 구조화된 boundary로 생성되었다고 확인한 것은 아니므로, 경계 전체 공백을 이 한 건으로 설명하지 않는다.

`node PROGRAM/tests/libra_character_info_admission_runtime_test.cjs`는 통과했다. 정상 인물 정보와 별칭의 저장, 알 수 없는 분류의 기억 보존, 잘못된 인용 제외, recall/replay/restart를 확인하는 통제된 모델 응답 검사다. 실제 모델의 추출 누락률이나 실제 채팅의 모든 소개·선호·경계 근거를 검증하는 테스트는 아니다.

수정 시에는 원문에서 직접 확인 가능한 소개·선호·경계가 분석에 포함되는지 점검하고 누락을 보완해야 한다. 사건이나 일시 반응으로 성격·선호를 만들어 채우거나, 인용 검증을 완화해서는 안 된다. 기존 정본에 없는 사실은 State 재생만으로 생기지 않으며 원문 재분석 또는 별도 근거 기반 보완이 필요하다. 캐릭터 설정/로어에서 가져올 소개와 대화에서 확인한 사실의 출처 구분도 별도 설계 대상이다.

관련 코드: `UNIFIED_CLAIMS` 58212행, 인물 정보 정규화 62059행, `unifiedPromptContract` 63415행 이후, `unifiedStateBindingsForRead` 63675행, 카드의 `groupKeys` 96533행.

## 3. “기록 없음”과 연결 항목의 동시 표시 — 코드로 확인

소속·사물 본문은 `affiliations`만 검사한다. 이 필드가 없고 인물 domain 상태가 ready이면 “이 분류에는 현재 기록된 항목이 없습니다.”를 표시한다.

별도의 `worldLinks`는 세계 도감의 모든 인물 연결을 수집하고, `linkedWorld` 상세를 같은 탭에 무조건 덧붙인다. 빈 안내는 이 연결 목록의 존재를 보지 않는다. 소유·소지·관리 항목이 실제 있어도 본문에 affiliations가 없다면 동일한 모순이 발생할 수 있다.

또한 `bookWorldAtlasModel`은 사람→장소의 현재 위치 연결을 장소→사람 역방향으로도 만든다. 인물 카드가 장소 쪽 역방향 연결을 수집하면서 **“현재 위치가 확인된 인물 · 폐공장”**이라는 표현을 만든다. 이 문구는 원래 장소에서 사람을 설명할 때의 관계명인데, 인물에서 장소를 설명하는 문맥에 재사용된다.

따라서 다음 세 결함이 겹친다.

1. 빈 안내 판단과 연결 목록 표시가 서로 다른 데이터 기준을 사용한다.
2. 소속·사물에 위치·접근 등 모든 세계 연결을 섞는다.
3. 인물 관점에서 보여줄 관계명을 역방향 라벨로 표시한다.

현재 위치 링크는 현재 상황으로 배치하고, 소속·사물은 소속·소유·소지·관리 등 해당 관계만 표시해야 한다. 빈 안내도 해당 탭에서 실제 표시하는 필드와 연결 목록을 모두 기준으로 계산해야 한다.

관련 코드: `bookWorldAtlasModel` 93017행, `groupKeys / groupFactNodes` 96533~96560행, `worldLinks / linkedWorld / panels` 96573~96575행.

## 검증의 한계

위치 참조 누락은 실제 저장 데이터와 현재 함수로 재현했다. 연결 분류·빈 안내·역방향 라벨은 실행 분기와 데이터 흐름으로 확인했다. 실제 RisuAI UI 재현, provider 호출, 설치 파일 교체, 재분석 및 데이터 수정은 수행하지 않았다. 소개·선호·경계가 들어갈 수 있었던 원문 전체의 항목별 누락률은 아직 측정하지 않았으며, 모든 공백을 버그라고 판정한 것은 아니다.
