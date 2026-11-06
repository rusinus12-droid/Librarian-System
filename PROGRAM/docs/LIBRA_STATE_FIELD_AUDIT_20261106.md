# 실제 State 필드 충족 현황과 원문 누락 대조

## 판정 범위

코드에 필드가 존재하거나 합성 provider 테스트가 성공했다는 사실을 실제 추출 성공으로 세지 않았다. 저장된 실제 Cloud 모델 실측 결과를 다시 집계하고, 원문에 근거가 있는데 최종 State가 빈 사례를 직접 대조했다. 이번 감사에서 새 모델 요청이나 코드 수정은 하지 않았다.

- **원문 실측:** `run-micro-synthesis-local-2`, T1~10, 인물 4명, 정본 저장 Head 세계 6건. 이후 Micro 종류 계약을 수정하기 전 결과다.
- **합성 양성/음성 실측:** `run-field-positive-1`, T1~5, 인물 3명, 세계 3건. Micro 종류 계약 수정 후 결과다. 최종 위치 안내 축약 직전 프롬프트로 실행했다.
- **집계 JSON:** `.development/libra-completeness-20261106/state-field-audit.json`.
- 원문과 합성 자료의 0을 합쳐서 '지원 안 됨'이라고 판정하지 않는다. 반대로 일부 성공 사례를 전체 추출 완전성으로 해석하지 않는다.

`정본 State`는 isolated-storage의 `libra.continuity_state.v2`에 저장된 Head다. `최종 조회`는 Micro 투영까지 합친 `after-canonical-10-state.json.head`다. Micro 반영 수는 동일 턴/analysisRevision/claimIndex에 admitted 결정이 한 번 이상 존재한 제안 수이며, 최종 State 항목 수와 다른 측정값이다.

## 원문 T1~10: 실제 정본 State의 필드별 수

### 인물

괄호는 해당 필드가 채워진 사람 수다. 배열은 항목 수, 단일값은 값을 가진 사람 수로 센다.

| 필드 | 정본 State | 채워진 인물 |
|---|---:|---|
| appearance | 1 (1명) | 세희 |
| background | 4 (3명) | 세연·세아·세희 |
| personality | 2 (2명) | 푸딩·세희 |
| speech | 0 | 없음 |
| habits | 0 | 없음 |
| abilities | 0 | 없음 |
| preferences | 0 | 없음 |
| boundaries | 1 (1명) | 세희 |
| locationRef | 4 (4명) | 전원 |
| condition | 2 (2명) | 세아·세희 |
| goal | 0 | 없음 |
| emotion | 3 (3명) | 세연·세아·세희 |
| knowledge | 2 (2명) | 세연·세희 |
| affiliations | 0 | 없음 |

이 항목 수는 정본 저장 Head와 최종 조회에서 일치한다. 소개 7항목은 외모 1+배경 4+성격 2이며, 모든 인물의 소개가 충분하다는 뜻이 아니다. 경계 1건도 scope의 subjectRef만 있고 targetRef/act/when은 모두 비어 있다. 내용 문자열에 조건이 적혀 있어도 구조화된 경계 축이 완성됐다고 세면 안 된다.

방향성 관계 State `relationships[]`는 **0건**이다. 가족이라는 배경 문장이나 GUI의 관계 이정표 수를 관계 State 수로 세지 않았다.

### 세계

| 필드 | 정본 저장 Head | Micro 포함 최종 조회 |
|---|---:|---:|
| description | 3 | 4 |
| sceneTime | 3 | 3 |
| containerRef | 2 | 2 |
| parentRef | 0 | 0 |
| ownerRef | 0 | 0 |
| holderRef | 0 | 0 |
| managerRef | 0 | 0 |
| access | 0 | 0 |
| rule | 0 | 0 |
| condition | 0 | 0 |

정본 설명 3건은 아르주나·좁은 방·폐공장이다. 최종 조회의 추가 1건은 Micro의 '방' 설명으로, 별개의 네 번째 장소가 검증됐다는 뜻이 아니다. '좁은 방'과 유사한 별도 이름 및 잘못된 사물 종류로 남았던 기록이며 후속 종류 수정의 계기가 된 사례다. 카메라·매트리스의 containerRef 2건이 있다. '세 모녀의 집'은 세계 항목으로 존재하지만 State는 비어 있다.

### 서사

| 필드 | 정본 State |
|---|---:|
| summary | 1 |
| primaryArcId | 1 |
| arcs | 3 |
| turningPoints | 3 |
| motifs | 2 |
| threads | 4 |
| events | 18 |
| locks | 3 |
| momentum | 1 |
| resolvedArcs | 0 |
| closedThreads | 0 |

존재하는 서사 항목에도 누락·잘못된 생명주기가 남을 수 있다. 특히 아래의 이행된 방문 과제는 여전히 open이다.

## 원문에서 Micro가 실제 반영한 범위

Micro 10개에 claim은 116개 있지만 State intent는 13개뿐이다. 그중 10개가 최소 한 번 직접 반영 승인됐고 3개는 값의 원문 바인딩 실패로 승인되지 않았다. 116개를 'State 116항목 반영'으로 말하면 잘못이다.

| 필드 | State 제안 | 직접 반영 승인된 고유 제안 |
|---|---:|---:|
| character.locationRef | 4 | 3 |
| character.condition | 6 | 5 |
| character.emotion | 1 | 1 |
| world.description | 1 | 1 |
| narrative.locks | 1 | 0 |

다른 필드의 State intent는 이 실행에서 0개다. Micro가 다른 영역의 일반 관측 텍스트를 전혀 저장하지 않았다는 뜻은 아니다. 일반 관측과 직접 State 제안은 별개이며 모두 정본 검토 입력으로 전달된다. 과거 승인된 변경이 이후 정본에서 수정/흡수/보류될 수 있으므로 이 수를 최종 인물 수와 더하지 않는다.

## 원문에 있는데 최종 State에 빠진 구체적 항목

| 기대 항목 | 원문 근거 | Micro | 정본/최종 State | 판정 |
|---|---|---|---|---|
| 세아의 붉은 눈 | T4 assistant의 '붉은 눈동자' 묘사, 이후 반복 | appearance 제안 0 | 세아 appearance 없음 | 외모 추출 누락 |
| 세아의 검은 머리 | T5 assistant의 '검은 머리카락' 묘사, 이후 반복 | appearance 제안 0 | 세아 appearance 없음 | 외모 추출 누락 |
| 세희의 붉은 눈 | T10 user의 빛이 '그녀의 붉은 눈'에 닿는 묘사, assistant에도 반복 | appearance 제안 0 | 흰 머리 1항목만 있고 눈 색 없음 | 외모 부분 누락 |
| 세희의 현재 목표: 딸들 보호 | T3 assistant: '그녀는 딸들을 지켜야 했다. 어떤 대가를 치르더라도.' | goal 제안 0 | goal 0 | 명시적 현재 목표 누락 |
| 혼자 지정 장소에 오라는 과제의 이행 | T5의 요구 → T9 user: '세희는 약속 장소에 혼자 왔다.' | 종결 State 제안 0 | '첫 번째 요구'가 open, closedThreads 0 | 이행된 하위 과제의 종결 누락 |
| 세희의 아침 준비 습관 | T3 assistant: '세희는 평소처럼 주방에서 아침 식사를 준비했다.' | habits 제안 0 | habits 0 | 명시적 습관 후보 누락; 하루 행동뿐이라고 분류하기 어려운 '평소처럼' 근거 있음 |
| 세희의 카페 운영 역할 | 정본 background에 이미 '카페 아르주나를 운영'으로 추출됨 | management 제안 0 | 아르주나 managerRef 0 | 서술형 배경만 있고 관리 관계로 구조화되지 않음 |
| 경계의 구조화된 범위 | 저장된 경계 content 자체가 '그 남자가 다시 오면 가게에 들이지 않겠다' | boundaries 제안 0 | 경계 내용 1건, targetRef/act/when 모두 빈 값 | 내용 수집은 됐지만 세부 축 불완전; 대명사 대상 확정과 행위·조건 추출을 구분해야 함 |

원문 인용의 존재는 격리 저장소의 completed_turn_receipt 텍스트에서 직접 확인했다. 외모·목표·습관에 해당하는 정본 fact가 없고, 두 번째 정본의 모델 원응답에도 resolve link가 없다. 해당 항목들이 validator에서 탈락한 것이 아니다. 이 실행의 정본 admission 거절은 '좁은 방' entity e5 및 이를 참조하는 위치 f24뿐이다. 따라서 위 외모·목표·종결 누락을 **저장 실패나 자료 부재로 설명하면 안 된다.** 모델의 후보 선택·추출·구조화/종결 판단 단계의 누락이다. 관리 관계는 배경에서 별도 typed claim으로 확장되지 않은 사례다.

두 번째 정본 요청에는 해당 방문 과제의 후보 alias와 요약이 실제 전달됐다. 후보 전달 누락으로 볼 근거는 없다. 첫 정본의 task 참여자가 owner=푸딩, target=세희로 기록된 점은 프롬프트의 'task owner acts' 계약과도 어긋나며, 종결 연결 실패 원인으로 추가 조사해야 한다. 이것만으로 모든 종결 실패의 원인을 확정하지는 않는다.

선택 로어의 세아 나이·검은 머리·붉은 눈도 별도 입력에 있었지만, 위 외모 누락은 로어에만 의존하지 않고 실제 대화 원문에서 확인했다. 원문·로어 전체를 사람이 완전한 정답표로 라벨링한 감사는 아니므로 이 목록은 누락의 하한이며, 전체 재현율을 계산하지 않는다.

## 합성 양성 자료에서 추가로 성공이 확인된 필드

| 필드/검사 | Micro 직접 반영 | 정본 State |
|---|---:|---:|
| preferences | 1 | 1 |
| habits | 1 | 1 |
| goal | 1 | 1 |
| locationRef | 1 | 1 |
| description | 2 | 2 |
| holderRef | 1 | 1 |
| closedThreads / fulfilled | 후보로 보존, 직접 확정 아님 | 1 |
| resolvedArcs | 직접 확정 아님 | 1 |
| 작은 방 / 청동 컵 | location / object | location / object |
| 일회성 동의의 지속 취향 오인 | 없음 | 없음 |

합성 자료의 직접 State 제안 7개는 모두 승인됐다. 정본 보류 0, 재생성 동일. 이것은 원문 실측에서 놓친 goal/habits/closure가 원래 자료에 없었다는 증거가 아니다. 같은 필드가 명시적인 단순 자료에서는 성공하고 복잡한 실제 원문에서는 누락될 수 있음을 보여 준다.

## 아직 실제 모델의 긍정 반영을 확인하지 못한 영역

두 실측을 합쳐도 **speech, abilities, affiliations, relationships, parentRef, ownerRef, managerRef, access, rule, world.condition**은 최종 State에 긍정 항목이 없다. 이 항목들은 통제된 provider 응답을 사용하는 회귀에서는 저장 경로를 검사했지만, 이번 실제 모델 자료로 실제 추출 성공을 입증하지 못했다. 원문에 근거가 없다는 판정이나 기능적으로 저장할 수 없다는 판정과 다르다.

따라서 현재 증거에 맞는 결론은 **인물·세계·서사의 일부 필드는 실제로 채워졌지만, 근거 있는 외모·목표·습관 후보·과제 종결·관리 관계와 경계 세부 축이 여전히 빠진다**는 것이다. '정본과 Micro가 State를 온전히 채운다'는 주장은 이 데이터로 지지되지 않는다.
