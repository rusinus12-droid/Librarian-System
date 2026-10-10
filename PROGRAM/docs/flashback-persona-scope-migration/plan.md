# Flashback Persona 독립 스코프 전환 및 하위 호환 마이그레이션 구현 계획서

- 작성일: 2026-09-04
- 기준 소스: `PROGRAM/plugins/Flashback_Memory.js` 1.0.25
- 문서 상태: 1차 안전 패치 구현 완료 / 2차 다중-source·portable/server·GUI 확장 대기
- 대상 범위: Flashback의 스코프 판별, 자동 캡처, 기존 저장소 호환, 영구 백업/복원, 서버 저장소 라우팅, 진단 GUI


## 0. 구현 체크포인트 — 2026-09-04 / Flashback 1.0.25

이 문서의 전체 목표 중 **신규 누락을 먼저 차단하는 1차 안전 패치**를 구현했다. 아래 체크 상태가 현재 코드의 실제 경계이며, 뒤의 전체 계획을 모두 완료했다는 뜻은 아니다.

- [x] 정본 `scopeKey`를 Persona 독립 `Character + Chat`으로 전환했다. Persona는 legacy alias와 `personaHistory` 진단 메타데이터로만 유지한다.
- [x] Persona A/B/미선택 및 DB/Persona가 없는 `CHAT_OUTPUT_V3`가 동일한 canonical scope로 수렴하는 회귀를 추가했다.
- [x] output callback 관측 자체가 아니라 실제 capture 또는 proven duplicate가 있을 때만 capture health를 정상으로 확정한다.
- [x] 구버전 pending journal의 Persona 포함 key도 동일 canonical chat으로 재결속할 수 있게 호환 필터를 추가했다.
- [x] 대상 canonical scope가 비어 있고 검증 가능한 legacy Persona source가 정확히 하나인 경우 기존 `cloneScopeStorage(..., same_chat_persona_recovery)` 트랜잭션으로 이전한다. source 레코드/commit 계보/vector sidecar 참조를 보존하고 target readback 뒤 활성화한다.
- [x] 단일-source 이전의 target readback과 반복 실행 중복 방지 회귀를 추가했다. 호환 vector는 재임베딩하지 않는다.
- [ ] legacy Persona source가 둘 이상인 경우의 결정론적 merge와 live transcript 기반 충돌 revision 판정은 아직 구현하지 않았다.
- [ ] portable backup/restore 및 mirror/server-only에서 다중 legacy source migration을 명시적으로 검증하는 전용 회귀는 아직 남아 있다.
- [ ] migration receipt/부분 전환 상태를 별도 GUI로 노출하는 작업은 아직 남아 있다.
- [ ] 실제 RisuAI에서 Persona 전환, 새 응답 capture, reload, mirror/server-only의 라이브 검증은 아직 남아 있다.

따라서 1.0.25는 **Persona 때문에 신규 저장소가 다시 갈라지거나 Persona 없는 공식 output이 pending을 놓치는 문제를 먼저 멈추는 버전**이다. 다중 legacy source 자동 통합은 자료 손실 위험 때문에 별도 2차 단계로 남긴다.

## 1. 결론

Flashback의 새 정본 저장 스코프는 **캐릭터 + 채팅**으로 통일한다.

```text
현재 구형 물리 키
char:<characterHash>|chat:<chatHash>|persona:<personaHash>

변경할 정본 물리 키
char:<canonicalCharacterHash>|chat:<canonicalChatHash>
```

Persona는 현재 사용자를 표현하는 메타데이터로만 유지하고, 저장소 소유권·리콜 범위·캡처 대기 턴 결합에는 사용하지 않는다. 같은 캐릭터와 같은 채팅이라면 Persona를 교체·재생성·미선택해도 같은 기억 저장소를 사용해야 한다.

기존 사용자의 Persona별 저장소는 삭제하거나 제자리 변환하지 않는다. 새 버전이 구형 저장소를 발견해 검증된 데이터만 새 정본 스코프로 복제·통합하고, 물리 readback이 끝난 뒤 별칭 레지스트리를 커밋한다. 구형 원본은 그대로 남겨 복구와 구버전 재진입에 사용한다.

이 작업은 다음 두 문제를 함께 해결해야 한다.

1. `CHAT_OUTPUT_V3` 이벤트 스냅샷에 Persona/DB가 없어서 요청 시 만든 Persona 포함 `scopeKey`와 출력 이벤트의 `scopeKey`가 달라지고, `pending_turn_not_found`로 자동 저장이 누락되는 문제
2. Persona가 바뀔 때 동일한 채팅의 기억이 별도 저장소로 분리되는 구조적 문제

## 2. 현재 문제와 확인 근거

### 2.1 현재 구현

`resolveScopeFromSnapshot()`은 캐릭터와 채팅의 정본 ID를 이미 계산하지만, 실제 `scopeKey`에는 `personaId`까지 넣는다.

```text
canonicalScopeId = char:<canonicalCharacterHash>|chat:<canonicalChatHash>
scopeKey         = char:<characterHash>|chat:<chatHash>|persona:<personaHash>
```

따라서 코드에는 Persona 독립 논리 ID가 존재하지만 실제 manifest, shard, vector sidecar, worldline, pending capture는 계속 Persona 포함 물리 키에 묶여 있다.

`flashbackChatOutputSnapshot()`은 공식 출력 이벤트에서 `character`, `chat`, `chatInfo`만 만든다. 이 스냅샷에는 DB와 선택 Persona가 없으므로 `resolveScopeFromSnapshot()`이 `persona:unknown`을 사용한다. 반면 `beforeRequest`가 등록한 pending 턴은 실제 선택 Persona가 들어간 키를 사용한다. 출력 이벤트는 pending 목록을 `pending.scope.scopeKey === scope.scopeKey`로 필터링하므로 정상 응답을 받아도 결합에 실패할 수 있다.

공식 출력 콜백은 실제 캡처 성공 여부와 무관하게 현재 health pending을 즉시 해제한다. 그래서 이벤트 횟수는 증가했지만 저장 revision과 `lastOutputCapture`가 비어 있는 상태도 정상처럼 보일 수 있다.

### 2.2 사용자 진단 파일에서 드러난 영향

진단 시점의 라이브 대화에는 U+A 턴이 13개 있었지만 고유 응답 턴 저장은 2개였고, 누락 판정은 11개였다. shard 손상이나 vector sidecar 누락은 없었으며 Voyage 1,024차원 벡터도 정상으로 확인됐다. 즉 이 사례의 주원인은 임베딩 실패가 아니라 **출력 턴과 pending 턴의 스코프 결합 실패**다.

### 2.3 이미 존재하는 호환 코드의 한계

현재 소스에는 다음 보호 장치가 있다.

- `sameCharacterChatIdentity()`: Persona를 무시하고 같은 캐릭터+채팅을 판별한다.
- `findSameChatPersonaScopeSource()`: 동일 채팅의 다른 Persona 저장소를 찾는다.
- `cloneScopeStorage()`: 대상이 비어 있을 때 shard와 vector sidecar를 복제하고 worldline을 이어 준다.
- 구형 원본 저장소는 삭제하지 않는다.

그러나 `findSameChatPersonaScopeSource()`는 후보 중 한 개만 선택한다. Persona를 여러 번 변경해 구형 스코프가 둘 이상이면 모든 기록을 검증·통합하지 못하고, 충돌하는 응답 revision을 라이브 대화와 대조하는 절차도 없다. 이 코드는 응급 복구 경로로는 유용하지만 정본 마이그레이션 엔진으로는 불충분하다.

## 3. 목표와 제외 범위

### 3.1 목표

1. 동일 캐릭터+채팅의 요청, 리콜, 출력 캡처, 유지보수, 백업이 항상 동일한 정본 스코프를 사용한다.
2. Persona 변경 여부와 상관없이 공식 출력 이벤트가 pending 턴에 정확히 결합되고 응답을 한 번만 저장한다.
3. 기존 Persona별 저장소를 무손실로 읽고 정본 저장소로 이전한다.
4. shard, archiveRef, vector sidecar, worldline을 물리 readback으로 검증한 뒤에만 전환한다.
5. 여러 구형 스코프의 중복·충돌을 라이브 transcript 기준으로 결정론적으로 처리한다.
6. 플러그인 저장, mirror, server-only 모드 및 영구 백업/복원에서 동일한 정본 키를 사용한다.
7. 마이그레이션 실패 시 현재 사용 가능한 원본을 유지하고 부분 전환을 노출한다.

### 3.2 제외 범위

- 서로 다른 채팅 ID의 자동 병합
- 서로 다른 캐릭터의 자동 병합
- 해시 검색 방식의 다국어 개선
- 리콜 랭킹·임베딩 모델·chunk 정책 변경
- 구형 Persona 저장소 자동 삭제
- 신버전에서 새로 쓴 턴을 구버전도 읽게 만드는 양방향 포워드 호환

마지막 항목은 명확히 구분한다. 이 계획이 보장하는 하위 호환은 **신버전이 구버전 데이터를 읽고 이전하는 것**이다. 구형 원본을 보존하므로 다운그레이드 시 기존 구형 데이터는 남아 있지만, 신버전에서 정본 스코프에 새로 추가된 턴은 구버전이 알 수 없다. 이를 보장하려면 영구 이중 쓰기가 필요하고 split-brain 위험이 커지므로 채택하지 않는다.

## 4. 변경 후 데이터 모델

### 4.1 스코프 ID

새 resolver는 논리 소유권과 표현 정보를 분리한다.

```js
{
  scopeIdentityVersion: 3,
  scopeKey: "char:<canonicalCharacterHash>|chat:<canonicalChatHash>",
  canonicalScopeId: "char:<canonicalCharacterHash>|chat:<canonicalChatHash>",
  canonicalCharacterId,
  canonicalChatId,

  // 표현 및 진단용. 물리 키 계산에는 사용하지 않음.
  personaId,
  personaName,
  personaObservedAt
}
```

정본 ID를 얻을 수 없는 구형 호스트에서는 기존 `characterId`와 안정된 `chatId`를 사용한다. chat ID가 없을 때 transcript fingerprint로 새 물리 스코프를 임의 생성하지 않는다. 요청 경로에서는 `scope_identity_unavailable`로 fail closed하고, GUI에서 호스트가 제공한 식별자를 진단할 수 있게 한다. 채팅 제목과 Persona 이름은 소유권 근거로 사용하지 않는다.

### 4.2 manifest 추가 필드

기존 manifest를 읽을 수 있도록 모든 추가 필드는 선택 필드로 둔다.

```js
{
  scopeIdentityVersion: 3,
  canonicalScopeId,
  canonicalCharacterId,
  canonicalChatId,
  legacyScopeKeys: [],
  migratedFromScopeKeys: [],
  migrationId: "",
  migrationCompletedAt: "",
  personaHistory: [
    { personaId, personaName, firstSeenAt, lastSeenAt }
  ]
}
```

`personaHistory`는 진단·출처 보존용이며 리콜 필터나 actor ownership 판정에 사용하지 않는다. 기록 자체에 있는 화자 메타데이터도 삭제하지 않는다.

### 4.3 별칭과 마이그레이션 영수증

레지스트리는 다음 관계를 보존한다.

- 정본 캐릭터+채팅 → 정본 `scopeKey`
- 구형 Persona 포함 `scopeKey` → 정본 `scopeKey`
- 마이그레이션 ID → 입력 source digest, 출력 commit ID, 레코드 수, archiveRef, worldline digest, 검증 시각

`migrationId`는 정본 키와 정렬된 source scope/digest로 계산해 재실행해도 같은 작업을 식별한다. 영수증이 있더라도 대상 물리 데이터 readback이 실패하면 완료로 인정하지 않는다.

## 5. 스코프 resolver 변경

### 5.1 단일 정본 함수

`resolveCanonicalFlashbackScope(snapshot)`를 추가하고 다음 모든 경로가 이를 사용하도록 한다.

- `beforeRequest`
- `CHAT_OUTPUT_V3`
- legacy output/afterRequest fallback
- 현재 스코프 통계와 GUI
- 저장·리콜·worldline
- 유지보수 동기화
- 영구 백업/복원 대상
- Storage SDK/server route descriptor

기존 `resolveScopeFromSnapshot()`은 일정 기간 호환 wrapper로 유지하되 내부적으로 정본 resolver를 호출한다. Persona 포함 구형 키 생성은 `legacyPersonaScopeKeyForDescriptor()` 같은 명시적인 탐색 전용 함수로 격리한다.

### 5.2 출력 이벤트 결합

공식 출력 이벤트에는 DB가 없어도 캐릭터와 채팅 ID가 있으므로 같은 정본 키를 만들 수 있어야 한다.

pending 결합 조건은 다음 순서로 검증한다.

1. 정본 `scopeKey` 일치
2. 사용자 메시지 ID/hash 일치
3. U+A pair index 또는 assistant position 일치
4. 최신 라이브 transcript의 user/assistant 본문 존재

Persona는 어떤 단계에도 조건으로 넣지 않는다. 동일한 이벤트 재전달은 기존 `turnKey + bodyHash + revision` 규칙으로 멱등 처리한다.

### 5.3 health 판정

출력 콜백 진입만으로 `captureBackendHealthPending`을 지우지 않는다. `processRisuChatOutputEvent()`의 결과를 받은 뒤 아래 중 하나일 때만 해당 pending의 health를 완료한다.

- `captured > 0`
- 같은 논리 턴이 이미 내구 저장되어 `duplicate`로 확인됨
- 명시적으로 stale/superseded 턴임이 검증됨

`pending_turn_not_found`, `scope_unavailable`, `logical_turn_not_ready`, 저장 실패는 health 성공이 아니다. 해당 사유와 event identity를 기록하고 bounded reconciliation을 예약한다. 다음 main `beforeRequest`까지 결합되지 않으면 기존 failover 정책을 실행하되 pending journal은 유지한다.

## 6. 기존 Persona 스코프 발견

### 6.1 탐색 순서

1. 정본 스코프 manifest 확인
2. 레지스트리에 기록된 legacy alias 확인
3. 레지스트리의 모든 동일 캐릭터+채팅 후보 확인
4. 필요한 경우에만 저장된 manifest 메타를 페이지 단위로 탐색

전체 저장소 키 열거는 `beforeRequest` 제한 시간 안에서 수행하지 않는다. 요청 경로는 확인된 alias까지만 사용하고, 전체 탐색과 마이그레이션은 deferred maintenance task로 넘긴다.

### 6.2 후보 승인 조건

자동 후보는 다음을 모두 만족해야 한다.

- canonical character ID와 canonical chat ID가 모두 같음
- 정본 필드가 없는 구형 manifest는 raw character ID와 안정된 chat ID가 모두 같음
- manifest가 존재함
- manifest가 가리키는 모든 commit shard가 존재하고 checksum이 맞음
- vector sidecar를 선언했다면 sidecar가 존재하고 digest/dimension이 맞음
- archiveRef가 있으면 연결된 archive manifest/shard가 검증됨
- source fingerprint가 탐색 전후에 변하지 않음

채팅 제목, Persona, message count, tail fingerprint는 보조 진단·우선순위 신호일 뿐 소유권의 단독 근거로 사용하지 않는다.

## 7. 마이그레이션 트랜잭션

### 7.1 상태 기계

```text
DISCOVERED
  → PREFLIGHT_VERIFIED
  → TARGET_STAGED
  → TARGET_READBACK_VERIFIED
  → REGISTRY_COMMITTED
  → ACTIVE

실패 경로
  → ROLLED_BACK
  → BLOCKED (rollback readback도 실패한 경우)
```

### 7.2 실행 절차

1. 정본 `scopeKey` 기준 write lock을 획득한다.
2. source 목록을 `scopeKey` 순으로 고정하고 각 source의 manifest, commit, shard checksum, vector sidecar, archiveRef, worldline digest를 스냅샷한다.
3. 기존 target manifest/worldline/registry/alias 값을 raw snapshot으로 보존한다.
4. source가 하나이고 target이 완전히 비어 있으면 기존 `cloneScopeStorage()`의 검증·sidecar 복제 로직을 일반화해 사용한다.
5. source가 여러 개이거나 target에 데이터가 있으면 8절의 결정론적 merge plan을 만든다.
6. 새 commit ID에 shard와 vector sidecar를 먼저 저장한다.
7. 저장된 shard/sidecar를 다시 읽어 레코드 수, checksum, vector 차원, source provenance를 검증한다.
8. live transcript 기준 worldline을 저장하고 다시 읽는다.
9. target manifest를 마지막에 커밋하고 다시 읽어 commit ID와 모든 shard 참조를 검증한다.
10. source fingerprint가 사전 값과 같은지 다시 확인한다.
11. 별칭 레지스트리와 migration receipt를 커밋하고 다시 읽는다.
12. 모든 readback이 성공한 뒤에만 `ACTIVE`로 전환한다.

### 7.3 롤백

manifest 커밋 전 실패하면 staging commit의 shard와 sidecar만 제거한다. manifest 커밋 후 실패하면 보존한 target manifest/worldline/registry raw snapshot을 복원하고 다시 읽어 확인한다. source는 처음부터 수정하지 않으므로 롤백 대상이 아니다.

롤백 readback까지 실패하면 `FLASHBACK_SCOPE_MIGRATION_ROLLBACK_INCOMPLETE`로 fail closed하고 자동 쓰기 전환을 금지한다. GUI에는 사용 가능한 legacy source와 미완료 target을 구분해서 표시한다.

## 8. 여러 구형 스코프의 병합 규칙

### 8.1 기본 원칙

라이브 RisuAI transcript가 현재 활성 worldline의 정본이다. 구형 스코프의 최신 시각이나 가장 큰 레코드 수만으로 활성 응답을 선택하지 않는다.

### 8.2 레코드 분류

각 source의 base response 기록을 다음 키로 묶는다.

- 안정된 user message ID가 있으면 해당 ID
- 없으면 `logicalTurnId` 또는 기존 `responseTurnGroupKey`
- 마지막 fallback은 정규화한 user text hash + turn 위치

그 후 다음 규칙을 적용한다.

1. 동일 논리 턴·동일 본문: 한 건만 유지하고 provenance와 더 완전한 메타데이터를 합친다.
2. 동일 논리 턴·동일 본문·서로 다른 벡터: 현재 provider/model/dimension/digest와 맞는 sidecar를 유지한다. 맞지 않는 벡터는 재사용하지 않되 원문은 보존한다.
3. 동일 논리 턴·서로 다른 assistant 본문: 라이브 transcript와 정확히 일치하는 revision을 활성 기록으로 선택한다.
4. 라이브 transcript에 없는 대안 revision: 삭제하지 않고 inactive variant 또는 immutable archive provenance로 보존하되 기본 리콜 후보에서는 제외한다.
5. live transcript에 결합할 수 없는 구형 기록: 자동으로 활성 history에 섞지 않고 legacy-unbound archive 집합으로 보존한다.
6. episode index는 파생 데이터이므로 source별 결과를 그대로 합치지 않는다. base response 통합 후 다시 계산한다.

### 8.3 자동 병합 중단 조건

다음 경우 자동 병합을 중단하고 GUI에서 수동 진단을 요구한다.

- 동일 캐릭터+채팅임을 안정된 ID로 증명할 수 없음
- 충돌 revision이 있는데 라이브 transcript를 읽을 수 없음
- source shard/archive/vector 선언과 물리 데이터가 불일치
- target이 preflight 이후 변경됨
- 둘 이상의 source에 같은 논리 턴의 서로 다른 본문이 있고 현재 worldline으로 판별 불가

## 9. 전환 중 읽기·쓰기 정책

### 9.1 읽기

1. 검증된 정본 target이 있으면 target만 읽는다.
2. target이 없고 검증된 legacy alias가 하나면 마이그레이션 전까지 해당 source를 읽을 수 있다.
3. 후보가 여러 개면 요청 hot path에서 임의로 합치지 않는다. 이미 검증된 migration receipt가 있을 때만 target을 사용한다.
4. legacy fallback을 사용했다면 GUI와 debug에는 `compatibility_read`로 명시한다.

### 9.2 쓰기

- `ACTIVE` 이후 새 캡처는 정본 target에만 쓴다.
- 마이그레이션 실행 중 새 쓰기는 정본 lock 뒤에서 대기시킨다.
- 마이그레이션이 안전하게 시작되지 못한 경우 현재 검증된 legacy source 하나에 계속 쓰고 `compatibility_write`를 표시한다. 빈 정본 target과 legacy source에 동시에 쓰지 않는다.
- 영구 이중 쓰기는 하지 않는다.

이 정책은 partial migration과 split-brain을 방지한다.

## 10. 영구 백업·복원 및 서버 경로

### 10.1 영구 백업

새 백업 envelope에는 `scopeIdentityVersion`, canonical character/chat ID, 원래 source scope 목록, migration receipt를 포함한다. 구형 Persona 포함 envelope는 계속 읽는다.

동일 채팅 복원은 캐릭터+채팅 정본 ID가 같으면 Persona 차이를 무시한다. 다른 채팅으로의 migration/copy는 명시적 사용자 작업이어야 하며 다음을 검증한다.

- 캐릭터 소유권 일치
- 대상이 비어 있거나 선택한 replace 정책을 만족
- copy 모드는 transcript fingerprint 일치

Persona 불일치는 경고 메타데이터로만 표시하고 단독 차단 사유로 사용하지 않는다. 캐릭터 불일치와 채팅 불일치는 계속 강하게 차단한다.

### 10.2 server/mirror/plugin-only

Storage SDK에 넘기는 owner scope는 정본 `scopeKey`를 사용한다. 레거시 서버 키도 discovery 후보에 포함하고, 서버에서 target으로 이전할 때도 source readback → target commit → target readback → alias commit 순서를 지킨다.

- `plugin_only`: 네트워크를 사용하지 않고 로컬 source/target만 처리
- `mirror`: 로컬과 서버의 정본 target이 SDK의 기존 충돌 규칙을 만족한 뒤 완료
- `server_only`: 서버 target의 물리 readback이 끝나기 전 로컬 성공으로 간주하지 않음

아카이브 참조는 복사하지 않고 공유할 수 있지만, 참조된 immutable archive 체인의 manifest와 shard를 모두 검증해야 한다.

## 11. GUI와 진단 변경

### 11.1 상태 표시

스토리지 또는 기억 유지보수 화면에 다음을 추가한다.

- 현재 정본 스코프: 캐릭터 / 채팅
- 현재 Persona: 정보용 표시, “저장 범위에 영향 없음” 설명
- 발견된 구형 Persona 스코프 수
- 검증 성공/실패/충돌 수
- 현재 모드: 정본 / 호환 읽기 / 호환 쓰기 / 마이그레이션 중 / 차단됨
- source와 target의 고유 응답 턴 수, shard, archive, vector sidecar 상태
- 마지막 migration ID와 readback 결과

### 11.2 사용자 동작

- target이 비어 있고 완전한 source가 정확히 하나면 백그라운드에서 자동 이전한다.
- source가 여러 개지만 충돌이 없고 live transcript로 모두 결합되면 자동 통합하되 완료 알림과 영수증을 남긴다.
- 충돌 또는 불완전 source가 있으면 `구형 스코프 검토` 버튼을 노출한다.
- 성공한 이후에도 `구형 원본 삭제` 버튼은 만들지 않는다. 삭제는 별도 설계·승인 전까지 지원하지 않는다.
- 기존 누락 턴은 마이그레이션만으로 새로 생기지 않으므로 완료 후 `누락·변경 턴만 동기화`를 실행하도록 안내한다.

헤더 건강 상태는 이벤트 관측 횟수가 아니라 라이브 U+A 턴과 저장된 고유 응답 턴, pending 상태, 마지막 캡처 결과를 기준으로 계산한다.

## 12. 오류 코드와 사용자 문구

| 코드 | 의미 | 사용자 조치 |
|---|---|---|
| `FLASHBACK_SCOPE_IDENTITY_UNAVAILABLE` | 캐릭터/채팅 정본 ID를 만들 수 없음 | 진단 로그 내보내기, RisuAI 호스트 정보 확인 |
| `FLASHBACK_SCOPE_MIGRATION_SOURCE_INCOMPLETE` | source shard/archive/sidecar 불완전 | 원본 보존, 복구 진단 실행 |
| `FLASHBACK_SCOPE_MIGRATION_MULTIPLE_CONFLICT` | 여러 source의 활성 revision 충돌 | 구형 스코프 검토 화면에서 확인 |
| `FLASHBACK_SCOPE_MIGRATION_TARGET_CHANGED` | 작업 중 target 변경 | 최신 상태로 재시도 |
| `FLASHBACK_SCOPE_MIGRATION_SOURCE_CHANGED` | 작업 중 source 변경 | 쓰기 종료 후 재시도 |
| `FLASHBACK_SCOPE_MIGRATION_READBACK_FAILED` | target 물리 readback 실패 | 원본 사용 유지, 서버/저장소 확인 |
| `FLASHBACK_SCOPE_MIGRATION_REGISTRY_COMMIT_FAILED` | 데이터 저장 후 별칭 커밋 실패 | 자동 활성화 금지, 재검증 후 재시도 |
| `FLASHBACK_SCOPE_MIGRATION_ROLLBACK_INCOMPLETE` | 롤백 readback 실패 | 자동 쓰기 차단, 디버그 로그 내보내기 |

화면에는 단순 “오류” 대신 “기존 기억은 보존되어 있으며 새 정본 저장소로 전환하지 않았습니다”처럼 데이터 상태와 영향 범위를 함께 표시한다.

## 13. 구현 순서

### 0단계 — 백업과 재현 fixture

- `Flashback_Memory.js`, 관련 테스트, manifest, checksum의 사전 SHA-256을 보존한다.
- 사용자 debug JSON에서 개인정보와 본문을 제거한 13턴/2저장/11누락 구조 fixture를 만든다.
- 현재 Persona 포함 output event가 `pending_turn_not_found`가 되는 실패 테스트를 먼저 고정한다.

### 1단계 — 정본 스코프 resolver

- `resolveCanonicalFlashbackScope()`와 legacy key parser/builder를 분리한다.
- Persona가 달라도 동일 캐릭터+채팅의 `scopeKey`가 같다는 단위 테스트를 추가한다.
- 캐릭터 또는 채팅 ID가 불명확하면 이름/fingerprint로 조용히 새 저장소를 만들지 않는 테스트를 추가한다.

### 2단계 — 신규 누락 차단

- `flashbackChatOutputSnapshot()`과 pending 결합을 정본 스코프로 전환한다.
- capture health를 처리 결과 기반으로 바꾼다.
- 실패한 이벤트의 bounded reconciliation과 pending journal 보존을 검증한다.

이 단계를 먼저 완료해 패치 이후 새 턴이 더 누락되지 않게 한다.

### 3단계 — legacy discovery와 단일 source 이전

- 레지스트리/manifest에서 모든 동일 캐릭터+채팅 후보를 수집한다.
- 기존 `cloneScopeStorage()`를 source 검증, staging commit, readback, receipt가 있는 공용 migrator로 확장한다.
- vector sidecar를 재임베딩 없이 그대로 이전하고 digest/dimension을 검증한다.

### 4단계 — 다중 source 통합

- 논리 턴 그룹과 중복 제거를 구현한다.
- live transcript 기반 revision 선택과 inactive/archive 보존을 구현한다.
- episode index를 base response에서 재생성한다.
- ambiguity fail-closed 경로를 추가한다.

### 5단계 — 모든 I/O 경로 전환

- recall, save, worldline, archive, 유지보수, debug, GUI 통계
- portable backup/restore
- Storage SDK route와 server/mirror/plugin-only
- native chat copy 및 session handoff에서 Persona 조건을 소유권 조건과 분리

### 6단계 — GUI와 기존 누락 복구

- legacy discovery/migration 상태와 영수증을 표시한다.
- 현재 사용자의 11개 누락 사례를 `누락·변경 턴만 동기화`로 채우는 회귀를 추가한다.
- 저장된 고유 응답 턴이 라이브 턴과 일치할 때만 정상으로 표시한다.

### 7단계 — 릴리스 동기화

- Flashback 버전, 변경 주석, 고정 버전 테스트를 함께 갱신한다.
- `program-manifest.json`과 `SHA256SUMS.txt`를 마지막 검증 후 재생성한다.
- 배포본은 소스와 테스트가 모두 통과한 상태에서만 생성한다.

## 14. 테스트 계획

### 14.1 필수 자동 회귀

1. beforeRequest에는 Persona A가 있고 output event에는 DB/Persona가 없어도 같은 정본 키로 정확히 한 번 저장됨
2. 동일 채팅에서 Persona A → B → 없음으로 바꿔도 scopeKey가 변하지 않음
3. target empty + legacy source 1개 이전 후 모든 shard/vector/worldline readback 성공
4. 이전 전후 legacy source의 manifest/shard/vector SHA-256 불변
5. 동일한 legacy source를 두 번 처리해도 중복 레코드나 새 commit이 생기지 않음
6. 여러 source의 동일 본문 중복 제거
7. 여러 source의 충돌 본문 중 live transcript와 일치하는 revision 활성화, 나머지 보존
8. live transcript 부재 시 충돌 자동 병합 차단
9. 기존 canonical target과 legacy source가 함께 있을 때 멱등 reconcile
10. vector provider/model/dimension/digest가 호환되면 임베딩 API 호출 0회
11. source shard, sidecar, archive chain 하나가 손상되면 target 활성화 금지
12. shard/sidecar/manifest/worldline/registry 각 단계 fault injection과 rollback readback
13. capture, portable export, migration이 겹칠 때 lock과 스냅샷 일관성 유지
14. plugin-only/mirror/server-only 각각의 target readback
15. 구형 portable Persona scope envelope의 same-chat 복원 성공
16. 다른 캐릭터 또는 다른 채팅의 자동 병합 차단
17. CHAT_OUTPUT_V3 이벤트 관측만 있고 capture 0이면 health가 정상으로 바뀌지 않음
18. 13개 라이브 U+A fixture에서 동기화 후 고유 응답 턴 13, 누락 0

### 14.2 정적·배포 검증

- `node --check PROGRAM/plugins/Flashback_Memory.js`
- Flashback 집중 회귀 전체
- server/storage/portable 관련 회귀
- `PROGRAM/run_regression_batch.py` 무인자 전체 실행
- `PROGRAM/tests/program_data_layout_test.cjs`
- manifest 파일 목록·SHA-256 readback
- 배포 ZIP 재검증

### 14.3 라이브 RisuAI 검증

자동 테스트 통과와 라이브 GUI 성공을 동일시하지 않는다. 실제 RisuAI에서 다음을 별도로 확인한다.

1. 기존 Persona A 채팅을 열어 legacy source 발견/이전 표시 확인
2. Persona B로 변경 후 같은 기억 분포와 고유 응답 턴 수 유지 확인
3. 새 응답 생성 후 `lastOutputCapture`, revision, manifest responseTurnCount 증가 확인
4. 새로고침 후 내구 readback 확인
5. `누락·변경 턴만 동기화` 후 13/13 및 누락 0 확인
6. mirror/server-only에서 서버 재시작 후 동일 결과 확인
7. 영구 백업 내보내기와 별도 빈 채팅 대상 복원 확인

## 15. 완료 기준

다음 조건을 모두 만족해야 완료로 본다.

- Persona가 달라져도 동일 캐릭터+채팅의 정본 `scopeKey`가 변하지 않는다.
- DB/Persona가 없는 공식 output event가 beforeRequest pending 턴과 결합된다.
- 이벤트 콜백 관측만으로 건강 상태를 정상 처리하지 않는다.
- 기존 Persona별 저장소를 source 변경 없이 정본 target으로 이전한다.
- 다중 source 충돌은 live transcript로 판별하거나 자동 처리를 중단한다.
- 호환 가능한 vector sidecar 이전에는 재임베딩 비용이 들지 않는다.
- archive, worldline, portable backup/restore, server route가 같은 정본 키를 사용한다.
- fault injection에서 부분 target을 활성화하지 않고 rollback readback을 수행한다.
- 13턴 재현 fixture가 저장 13, 누락 0이 된다.
- 전체 회귀, manifest, checksum 검증이 모두 통과한다.
- 실제 RisuAI에서 Persona 전환, 신규 캡처, 새로고침 후 readback을 확인한다.

## 16. 배포 및 롤백 운영

1. 업데이트 전 영구 백업을 만든다.
2. 새 버전 첫 실행에서 정본 target과 legacy source를 진단한다.
3. 안전한 단일 source는 자동 이전하고, 다중 충돌은 사용자에게 검토를 요청한다.
4. migration receipt와 source 불변 검증을 확인한다.
5. 누락 턴 동기화를 실행한다.
6. 새 턴을 한 번 생성해 공식 output capture와 새로고침 후 readback을 확인한다.

문제가 발생하면 신버전의 정본 target 활성화를 중단하고 보존된 legacy source로 compatibility read/write를 계속한다. 구형 원본은 자동 삭제하지 않으므로 데이터 복구가 가능하다. 다만 신버전에서 정본 target에만 추가된 새 턴은 구버전에서 보이지 않을 수 있으므로, 다운그레이드 전에는 반드시 신버전 영구 백업을 보존한다.

## 17. 승인 후 첫 패치 범위

첫 패치는 한 번에 전체 마이그레이션 GUI까지 넓히지 않고 아래 경계로 시작한다.

1. 실패 재현 테스트
2. Persona 독립 정본 resolver
3. `CHAT_OUTPUT_V3` pending 결합 및 health 판정 수정
4. 단일 legacy source의 무손실 이전 트랜잭션
5. source 불변·target readback·멱등성 테스트

이 경계가 통과한 뒤 다중 source merge, portable/server, GUI 순으로 확장한다. 이렇게 하면 신규 누락을 먼저 멈추면서 기존 사용자 데이터의 이전 범위를 단계별로 검증할 수 있다.
