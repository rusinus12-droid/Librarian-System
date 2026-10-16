# WM v6.0.0 HME 연상 그래프 검토

검토 기록일: 2026-10-14 (Asia/Seoul). 사용자가 첨부한 `LIBRA_World_Manager.js`의 구현을 읽고 검색 호출 경로를 추적했다. 플러그인을 실행하거나 실제 호스트에서 검색 품질·성능을 측정하지 않았다.

- 원본: 사용자 첨부 `LIBRA_World_Manager.js`, display-name v6.0.0, 6,666,632 bytes / 97,920줄. 아래 줄 번호는 이 exact 첨부본 기준이며 저장소의 LIBRA.js를 가리키지 않는다. 원본 플러그인 전체를 제품 코드로 추가하지 않았다.
- SHA-256: `75bbe7f130f10cfcfd03647c046b569808dc23110f10cd263de7ab290a128b67`
- 비교 설계: [통합 설계](LIBRA_UNIFIED_MEMORY_ENGINE_DESIGN.md) v1.0, 기준 커밋 `0c1976a`. 이번 검토의 결정은 v1.1에 반영한다.
- 재확인 방법: 같은 원본의 SHA-256을 먼저 확인한 뒤 아래 함수·줄 번호와 발췌를 대조한다. 원본 첨부가 없는 checkout은 이 기록의 설계 결정은 확인할 수 있으나 첨부본 코드 전체를 독립 재감사할 수는 없다.

## 결론

WM에는 재사용할 만한 연결망 구현이 있다. 특히 인물 허브, 역할별 연결 가중치, 원본 그래프와 요청별 적격성의 분리, 저장 그래프의 원본 기반 재검증이 유용하다. 그러나 검색은 여전히 휴리스틱과 임베딩의 두 결과를 RRF로 합친다. HME를 그대로 도입하면 사용자가 원하는 하나의 검색 엔진이 완성되는 것은 아니다.

## 서로 다른 두 그래프 경로

| 경로 | 노드 종류 | 주요 연결 | 범위 |
|---|---|---|---|
| 기존 HME graph v2 / 구현 version 5 | memory, entity, lore | 기억–인물, 인물–로어, 인물–인물 관계, 기억–로어, 기억–기억 연상 | 로어북 원본과 cue 자료를 읽어 파생 그래프 구축 |
| TypedHmeSourceGraph v1 | memory, entity, world, narrative | 기존 그래프 컴파일러를 재사용한 구조·연상 연결 | typed 원본에서 영속 그래프를 만들고 요청마다 적격 부분 그래프 생성 |

근거: 기존 교차 종류 엣지 `63871`, 컴파일러 `64293`, typed 그래프 `65355`, typed corpus `69827`, adapters `70129`.

typed 경로는 별도의 Micro adapter나 일반 lore adapter를 열거하지 않는다. world adapter에는 세계 규칙, 세계 상태 이력·요약, codex fact가 들어간다. entity adapter에는 인물 상태와 관계가 표현된다. 따라서 `memory/entity/world/narrative`를 LIBRA의 `정본/Micro/상태 추적/로어북`과 일대일로 대응시키면 안 된다.

typed compile은 `typedNodes`만 전달하고 별도의 lorebook을 전달하지 않는다. 기존 entity–lore와 canonical relation map 연결이 typed 경로에도 모두 존재한다고 가정할 수 없다. world/narrative의 부모·기억 참조가 node sourceRefs에 들어가는 것과 독립적인 의미·근거 엣지를 구축하는 것도 구분해야 한다.

## 실제 검색 경로

`beforeRequest`에서 `TypedRecallRollout.retrieve`를 호출하는 경로가 있다(`82178`). rollout은 `DualRecallEngine.retrieve`를 호출한다(`71983`). 기능 활성화 여부와 실제 사용 모드는 설정·provider·rollout 조건에 달려 있다.

DualRecallEngine의 경로(`71446`):

1. typed 원본 열거와 현재성·범위 검증.
2. 휴리스틱 검색 실행: memory는 기존 MemoryEngine, 다른 종류는 adapter 휴리스틱 사용.
3. 별도 SemanticRecallEngine 검색 실행.
4. 두 경로에서 채택된 시드를 교차 배치하여 HME 그래프 확장 한 번 실행.
5. 그래프 결과는 휴리스틱 결과 안에서 점수를 반영. 독립적인 세 번째 RRF 표를 주지 않음.
6. 휴리스틱 결과와 semantic 결과를 RRF로 융합(`71390`, `71486`).
7. 다양성/MMR 선택과 소비자 검증.

즉 자료의 identity와 검증 경계는 공유하지만, 후보 깊이 제한·순위와 최종 융합은 두 검색 경로에 의존한다.

## 차세대 설계에 가져올 부분

| 구현 | 가져올 원칙 | 근거 줄 |
|---|---|---|
| 인물 허브와 memory/entity/lore 연결 | 모든 자료를 공통 대상 노드를 통해 연결 | 63871 |
| primary/observer/mention/inferred 역할 가중치 | 단순 이름 중복과 실제 사건 당사자를 구분 | 63917 |
| 빈도 페널티·일반 주제 억제 | 자주 등장하는 인물·단어만으로 후보가 독점되는 현상 억제 | 63014, 63999 |
| 구조 엣지를 공통 edge budget 안에서 먼저 보존 | 근거·대상 연결이 조밀한 연상 연결에 밀려 사라지지 않게 설계 | 64313 |
| 원본 그래프와 요청별 적격 부분 그래프 분리 | 질문·시점·viewer 때문에 영속 원본 그래프를 매번 다시 쓰지 않음 | 65432, 65548 |
| 보호 자료를 중간 경유에서도 제외 | 출력문 redaction만으로 해결되지 않는 간접 경로 노출 방지 | 65558 |
| 재시작 시 노드·엣지를 현재 원본에서 재계산해 검증 | 저장된 파생 인덱스의 checksum만으로 원본 권위를 인정하지 않음 | 65471 |
| epoch, 최신 요청 token, scope별 write barrier | 취소·복원·경합 뒤 오래된 작업의 RAM 게시 방지와 저장 순서 보존 | 65359, 65525 |
| edgeChain, node/edge 표본, 누락 노드 수 | 검색 경로와 실제 보존 범위를 관측할 수 있게 함 | 65303, 65576 |

역할 가중치나 threshold 수치를 그대로 복사할 근거는 없다. 원칙과 계약을 가져오고 수치는 LIBRA 자료와 질의로 검증해야 한다.

## 다시 설계해야 할 부분

1. **검색 제어:** 별도 휴리스틱·semantic 순위와 RRF 대신, 직접 신호를 공통 노드의 초기 활성화로 넣고 하나의 frontier·평가·종료 기준에서 확장한다.
2. **전파:** 기존 확장은 시드마다 FIFO BFS를 수행하며 최대 2홉으로 제한한다(`65048`, `65203`). 의미 엣지와 인물 허브를 추가 전파하고 층·홉별 고정 감쇠를 쓴다. 일반 노드는 첫 방문 뒤 다시 평가하지 않아 더 강한 후속 경로가 전파되지 않을 수 있다. 차세대 strongest-path 활성화에는 점수 개선에 따른 재평가가 필요하다.
3. **범위와 보존:** bucket 40, memory pair 선택 단계의 local edge 8, 시드·후보·추가·노드·전체 엣지 상한이 있다(`63011`, `63045`, `64347`). 8은 모든 노드의 최종 degree 제한이 아니다. 기존 bounded resident graph에 포함되지 않은 원본도 공통 durable shard에서 발견할 수 있어야 하며, 생략·미탐색과 결과 완전성을 별도로 보고해야 한다.
4. **관계 모델:** unordered endpoint pair를 중복 키로 사용하고 양방향으로 탐색한다(`63888`, `64319`, `65245`). 같은 두 대상 사이의 여러 술어·방향·유효 시점·출처를 표현할 차세대 엣지 identity와 구분해야 한다. 이름/별칭 매칭도 안정적인 대상 identity를 대체하지 않는다.
5. **사실과 연상:** `causal_followup`, `resolves_thread` 같은 이름은 신호·규칙으로 추정되는 검색 연관성을 포함한다(`63999`). heuristic confidence와 trace는 확정된 인과·정정·원문 근거가 아니다. 현재 typed corpus도 원본 span 계보를 partial/unknown으로 관측한다(`70443`). 의미 엣지, 연상 엣지, 물리적 근거를 분리해야 한다.
6. **변경 처리:** typed 그래프는 동일 fingerprint의 노드를 재사용하지만 warm 유지도 전체 sourceRows revision을 계산한다(`65442`). 수정 때 retained graph의 엣지 전체를 재컴파일한다(`65515`). owner revision/change set, 역의존성 인덱스, 최소 영향 shard 게시가 필요하다.
7. **캐시·Lane·인덱스:** typed state는 최대 48 scope를 개수 기준으로 보관하며 retained graph 외 전체 source node map도 유지한다(`65521`). HME의 이 캐시를 공통 바이트 예산·공유 페이지·pin/lease·축출·무효화 및 Memory Lane I/O 스케줄러로 재구성해야 한다. 다른 WM 캐시의 바이트 제한 존재 여부와는 별개의 문제다.
8. **조회 중 게시:** WM 계약은 derived cache cold build 저장을 조회 중 허용한다(`64695`); typed search도 maintain/persist를 호출할 수 있다. 현재 LIBRA 차세대 문서의 조회 경로 쓰기 금지와 맞추려면 durable build/publication을 유지보수 경로로 옮기고, 질의에는 검증된 generation이나 요청 내 임시 구조를 사용해야 한다.
9. **진단 정합성:** candidate boost는 기존값과 새값의 max를 저장하지만 edgeChain 등 일부 설명은 새 경로로 덮어쓴다(`65157` 부근). 최댓값의 증거 경로와 진단이 같은 경로를 가리키도록 원자적으로 갱신할 필요가 있다.

## 기존 문서 판단의 적용 범위

`MAIN_MEMORY_TRACEABILITY.md` §9의 “가져올 것 없음” 판단은 HME 시작 줄 `51713`인 이전 원본과 현행 associative adapter의 기능 대응을 비교한 내용이다. 이번 첨부본은 HME가 `62998`에서 시작하며, typed 원본 그래프와 재검증 구현이 추가돼 있다. 차세대 설계에서는 이전 판정을 이 첨부본 전체에 적용하지 말고 재사용 계약을 다시 평가해야 한다.

권장 방향: WM의 연결 구성·원본 검증·변경 가드 구현을 차세대 설계의 참고 구현으로 채택하고, 검색 제어와 저장·캐시·Memory Lane은 LIBRA의 통합 엔진 계약에 맞추어 새로 구성한다.

## 설계 반영과 최소 코드 발췌

[통합 설계 v1.1](LIBRA_UNIFIED_MEMORY_ENGINE_DESIGN.md)의 §2.3은 재사용 결정을, §4.4/§4.5는 다중 관계·역할과 SourceGraph/QueryGraphView를, §6은 activation 개선 시 재평가·winning path 정합성을 명시한다. §7.7/§9.3은 cache/Lane/index, 조회 중 durable write 금지, restart 검증·delta 게시를 구체화한다. V13–V18과 UM0–UM4에 해당 수용 기준을 추가했다. [이전 추적표](MAIN_MEMORY_TRACEABILITY.md) §9의 복원 판정도 이전 원본에 한정했다.

다음은 구현의 작은 발췌다. 호출 조건·실제 activation 여부는 전체 함수 및 registered hook을 함께 읽어야 한다.

```js
// TypedHmeSourceGraph, L65366: 원본 그래프의 종류
const families = ['memory', 'entity', 'world', 'narrative'];

// HME derived storage contract, L64695: 조회 중 파생 저장 허용
const HME_DERIVED_STORAGE_CONTRACT = Object.freeze({ writeClass: 'cache-derived', canonical: false, rebuildable: true, searchTimeWrite: 'allowed-cold-build' });

// DualRecallEngine.retrieve, L71486: 두 검색 결과의 융합
const fused = fuseRrf(h, s, p.rrf || {}); trace.union = fused.length;

// expandHmeGraphRecallCandidates, L65157/L65160: 최댓값과 경로 갱신의 차이
boost: Math.max(prev?.boost || 0, boost),
edgeChain: chain.length ? chain : (prev?.edgeChain || []),
```

이 발췌와 정적 검토는 실행·성능·실제 호스트 검색 품질 검증을 대신하지 않는다. V13–V18은 후속 구현의 gate이며 이번 문서 갱신에서 실행한 테스트 결과가 아니다.
