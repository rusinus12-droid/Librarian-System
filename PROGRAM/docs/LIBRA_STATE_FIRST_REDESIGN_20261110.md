# LIBRA State 중심 기억 엔진 — 1차 전환

> 후속 설계 결정: 정본·Micro·State는 현행 유지하고 렌즈 40%·공통 근거 60%로 배분한다.
> 공통 근거는 질문에 따라 응답용 State·정본·Micro를 선택하며 State는 승인된 Micro까지 투영한다.
> 아래 2차 작업에 추가됐던 Lore 직접 전달은 사용자 요청으로 제거했다.
> 최신 동작과 검증은 `LIBRA_WEIGHTED_MEMORY_RECALL_20261110.md`를 참고한다.

작업 브랜치: `codex/libra-state-first-memory-engine` (기준 `e136fec3`).
기존 기억을 읽기 위해 통합 그래프나 상설 그래프를 생성·게시하는 과정을 폐기한다.
현재 구현은 새 엔진의 시작점이며 검색 품질과 실사용 지연 검증이 완료된 릴리스는 아니다.

## 설계 기준

레퍼런스는 `plugins/HAYAKU_Locator_Continuity.js`의
`buildHayakuSelectionPolicy`와 sparse RRF 설계다. HAYAKU는 축별 target/limit과
전체 행·문자 예산을 가진다. LIBRA는 기존 State 스키마의 인물·관계·세계·서사
네 축을 유지하고, 공유 순위 선택 전에 축별 최소량 확보 단계를 명시적으로 실행한다.

1. 현재 스코프·세계선의 저장된 State Head와 기존 기록 목록을 읽는다.
2. State의 축별 필드와 근거 위치를 선택한다.
3. State 근거 위치와 질의어·기존 목록 메타데이터로 Canonical 후보를 정한다.
4. 근거 턴 및 최근 Micro 후보를 읽고, 검증된 기존 문장을 선택한다.
5. 선택한 원문과 State·세계선·리뷰 정책이 여전히 같은지 검증한 후 전달한다.

그래프 정점/간선 변환, corpus 게시, 그래프 임대, 그래프 증분 갱신은 이 경로에 없다.
검색을 위해 모델이나 임베딩 서비스를 호출하지 않는다.

## 구현 범위

- `tools/libra_state_memory_engine.cjs`: State 행 투영, 이름 참조 해석,
  후보 순위, 축별 확보, 중복 제거와 문자·항목 예산.
- `tools/libra_state_memory_capture.cjs`, `tools/libra_state_memory_runtime.cjs`:
  기존 자료 읽기, 후보 상한, 선택 결과와 비공개 전달 권한.
- `sdk/LibraStateMemoryOwner.source.js`: 기존 저장·검증 체계에 연결하는 어댑터.
  리뷰 정책은 요청 스냅샷에서 재사용하며 최종 검증에서 변경을 감지한다.
- `tools/sync_libra_state_memory.cjs`: 소스 모듈을 LIBRA 단일 플러그인에 동기화.
- `plugins/LIBRA.js`: 기존 그래프/네트워크 팩토리와 실행·구축·구조 화면 제거,
  State 검색 설정 및 Classic/GRADIA 연결. 예전 엔진 설정은 `state_first`로 이행.
- GRADIA 읽기 영수증은 그래프 대신 선택 결과에 결합한다.
  기존 wire의 `unified_engine` 이름은 프로토콜 호환용으로 유지하며
  `servingEngine: state_first`로 실제 실행 엔진을 명시한다.

기본값: 축별 2항목, 전체 최대 24항목, Canonical 후보 16개, Micro 후보 12턴.
축에 검증된 자료가 없거나 전체 예산이 부족하면 부족 이유를 표시한다.
없는 정보를 만들어 할당량을 채우지 않는다. 후보 상한으로 전체 과거를 읽지 못하면
`queryComplete: false` / `deliveryOutcome: partial`로 표시한다.

기존 State·Canonical·Micro의 생성·저장 스키마와 자료는 유지한다.
서버의 예전 그래프 저장 자료를 자동 삭제하지 않는다. 후속 철거 작업에서 공유 SDK·서버의
그래프 지원 코드와 전용 도구·테스트·호환 API도 제거했다.
구체적인 범위는 `LIBRA_GRAPH_RETIREMENT_20261110.md`를 참고한다.

## 검증과 한계

자동 검증은 `libra_state_memory_engine_test`, `libra_state_memory_runtime_test`,
`libra_gradia_unified_read_owner_test`, `libra_memory_engine_mode_test`를 대상으로 한다.
세 저장 모드, 축별 확보, 재시작 후 기존 자료 읽기, Classic 실제 주입,
GRADIA 영수증과 원문 변경 거부, 취소·만료, 엔진 이행을 검증한다.
그래프 요청 및 검색 중 파생 corpus 쓰기가 없고 모델 호출이 늘지 않는지도 확인한다.

위 네 테스트 파일의 38개 검증을 모두 통과했고, 두 플러그인의 문법 검사와
State/GRADIA 소스 동기화 검사 및 `git diff --check`도 통과했다.

17턴 로컬 서버 fixture는 생성·게시 쓰기 없이 검색된다(이번 실행 194요청,
83~98ms, 검색 중 KV 쓰기 0회). 이는 네트워크 지연이
거의 없는 합성 시험이며 실제 서버·대규모 과거 자료의 응답 시간을 보장하지 않는다.
원본 요청 수는 `.development/state-engine-transition/latest-tests.log`에 기록한다.
실제 RisuAI UI·설치·원격 제공자 검증은 수행하지 않았다.

## 2차 고도화 반영 내역

- **검색 순위화 고도화 (HAYAKU 레퍼런스 이식)**:
  - `tools/libra_state_memory_engine.cjs`:
    - 단어 토큰 및 한국어·CJK 형태소 분절 대응 문자 n-gram(바이그램/트라이그램) 추출.
    - BM25 점수화(문서 길이 정규화 및 역문서 빈도 IDF 산출).
    - 정확 일치(exactSignal), 문자 n-gram 커버리지/자카드(charNgramSignal), State 근거(anchorSignal) 다중 신호 분리.
    - Sparse RRF(Reciprocal Rank Fusion, k=60, blend=0.20)를 통해 다중 채널 단조 결합 순위화 적용.
- **Canonical 검색 메타데이터 갱신 및 비파괴 이행**:
  - `memoryRefFromStoredMemory`: 신규/갱신 저장 시 `title`, `searchText`, `searchTerms`, `recallTerms` 컴팩트 메타데이터를 매니페스트 레퍼런스에 함께 기록.
  - `upgradeCanonicalManifestSearchMetadata`: 오래된 매니페스트 기록에 대해 전체 원문 재구축 없이 검색 메타데이터를 증분 백필하는 이행 도구 제공. 메타데이터가 없는 구기록은 최근성 및 State 근거 중심 후보로 정상 안전 폴백.
- **State Head 시점 및 최신성 공시 (Point-in-Time Freshness Disclosure)**:
  - `tools/libra_state_memory_runtime.cjs`: State Head 기준 턴(`stateAsOfTurn`), 최신 턴(`latestTurn`), 최신성 상태(`headFreshness: 'current' | 'lagging'`), 턴 지연(`turnLag`), 정직한 시점 안내문(`pointInTimeNotice`)을 diagnostics 및 bundle 메타데이터에 명시하여 동적 재투영 오인을 원천 방지.
- **Lore 직접 검색 및 전달 통합**:
  - `tools/libra_state_memory_capture.cjs`, `tools/libra_state_memory_runtime.cjs`, `sdk/LibraStateMemoryOwner.source.js`: 활성 로어북 후보를 `family: 'lore'`, `axis: 'world'`로 투영하여 direct recall 후보군에 포함하고 예산 내 공유 순위 선택 지원.

## 후속 과제

- 리뷰 정정의 정밀한 State 재투영.
- 대규모 이력(수백 턴 이상)의 검색 회귀 벤치마크 평가.
- 원격 네트워크 지연 환경에서의 요청 수/지연 시간 실측 및 다중 후보 묶음(batch) 읽기 최적화.

이전 미커밋 그래프 후속 수정은 `.development/state-engine-transition/pre-state-redesign/`
안에 별도 패치로 보관되어 있다. 새 엔진에 다시 적용하지 않는다.

## 3차 반영 내역 (2026-11-11) — 기존 색인·캐시 연결

새로 만드는 색인은 없다. 이미 저장돼 있거나 실행 중에 유지되는 것을 검색 경로에 연결했다.

- **Micro head의 검색 요약 사용**: 각 Micro head에는 발행 때 함께 저장된
  `recallProjection`(요약·검색 본문)이 있다. 검색은 head를 32개씩 묶어 읽어 턴별 검색 본문을
  얻고, 질의와 일치하는 오래된 턴을 후보로 올린다. 읽은 요약은 실행 중에만 보관하며
  (`sourceRevisionId`가 현재 턴과 같을 때만 재사용) 저장하지 않는다. 요약은 후보 선택에만 쓰고,
  전달 문장은 기존의 검증된 Micro 읽기에서만 나온다. 최신 턴 2개는 항상 후보에 남긴다.
- **읽기 프레임·검증 읽기 캐시 연결**: 한 검색 안에서 같은 head·receipt를 여러 번 읽던 것을
  기존 background read frame으로 공유하고, 사용한 키 전체를 반환 전에 묶음으로 한 번 검증한다.
  프레임이 변경을 감지하면 프레임을 버리고 공유 없는 기존 검증으로 다시 판정한다.
  이후의 최종 전달 검증도 같은 방식으로 자체 프레임을 쓴다.
- **기존 회상 토크나이저 사용**: 조사 제거·한글/CJK 글자쌍을 만드는 `libra_recall_tokenizer`를
  엔진에 연결했다. 단어 반복 횟수를 유지하는 `bm25TermFrequency`를 추가했다.
- **BM25F**: 정본 목록은 제목·요약·검색어 필드별 가중치와 전체 목록 통계(문서 빈도·평균 길이)로
  점수를 낸다. 목록은 이미 manifest에 있으므로 추가 읽기가 없다.
- **인물 동일성 신호**: State head의 이름·별칭으로, 질의에 쓴 이름과 다른 표기를 쓴 기록도
  같은 대상으로 인식한다. 추가 읽기 없음.
- **연결 근거 신호**: 과거 경위·세부 질문에서 질의와 가장 잘 맞는 State 필드(최대 4개)의
  근거 문장을 함께 올린다. 현재 상태 질문의 중복 억제는 그대로다.
- **렌즈 축 분류**: 렌즈 노트를 모두 서사 축에 넣던 것을, 노트의 인물 수와 언급한
  State 대상에 따라 인물·관계·세계·서사로 나눈다.
- **완결 표시**: 모든 턴의 검색 요약을 확인했고 일치한 턴을 전부 읽었으면 Micro는 전체 검색으로
  본다. 일치한 턴이 후보 상한보다 많으면 지금처럼 `partial`이다.

17턴 로컬 서버 fixture 측정: 검색 1회 345요청 → 첫 검색 12~13요청, 이어진 검색 7요청.
검색 중 쓰기 0회. 예전에는 최근 8턴만 읽어 9턴을 묻는 질의에 9턴 Micro가 빠졌고, 지금은
`index_match`로 선택된다. 지연이 거의 없는 합성 시험이며 실제 원격 서버·RisuAI UI 검증은 하지 않았다.

연결하지 않은 것: 정본 임베딩 벡터(질의 때 임베딩 제공자 호출이 필요), 근거 링크 색인·로어 링크
색인(기본 꺼짐, 구축 때 모든 정본을 읽음). 회수 진단 화면은 새 엔진의 실제 수치(읽은 후보/전체,
질문 분류, 축별 선택, 배분)로 바꿨다.
