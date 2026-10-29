# 리콜·전송 지연·GUI 초기 표시·GRADIA 범용화 패치 — 2026-10-30

## 근거

2026-10-29 16:56 UTC 디버그 4종(LIBRA 2.6.8, HAYAKU 3.3.8, Flashback 1.3.8, GRADIA 0.28.2)과 같은 시점 LIBRA 서버 DB 사본(읽기 전용)을 대조했다. 사용자 DATA는 변경하지 않았다.

공통 원인: 서버 응답은 수 ms(HAYAKU 원장 GET 10ms)인데, 플러그인이 RisuAI `nativeFetch`(Tauri) 경로로 큰 값을 받는 데 수 초가 걸렸다. 그 결과 각 플러그인의 짧은 단계 제한이 먼저 끝나 리콜이 건너뛰어졌다.

## 원인과 수정

- **GRADIA 인풋 `novel_input_choices_schema_invalid`**: 모델이 선택지 자체는 맞게 냈지만 `schema` 필드를 빠뜨리거나 이름을 바꾸거나, 배열만 반환하거나 한 단계 감싸면 즉시 실패했다. 봉투만 복구하고(`coerceInputChoicesPayload`, 배열 응답 파서) 선택지 검증은 그대로 둔다. 다른 GRADIA 산출물 스키마나 산문은 계속 거부한다. 관점 표기가 없는 정확히 3개 후보는 요청 순서로 배정한다. 그래도 형식이 틀리면 형식 전용 재시도를 한 번만 한다(RP 선택지 모드 동일).
- **GRADIA 기억 연결**: 저장된 연결 동의가 있어도 시작 시 첫 연결이 실패하거나 500ms 감시에서 일시 오류가 나면 영구히 끊긴 상태로 남았다(디버그 `LIB_READ_CONNECTION_UNAVAILABLE`). 같은 URL·같은 owner로 지수 백오프 재연결(최대 60초)하고, 기억 읽기 직전에는 최대 4초 재연결을 기다린다. 사용자 해제·URL 변경·가져오기·종료 시에는 재연결하지 않는다. owner 추가, 권한·스코프·현재성 검사는 바뀌지 않는다.
- **GRADIA 모델 범용화**: DeepSeek V4.1 Flash만 1M로 인식하던 이름 추정을 모델 계열·세대로 넓혔다(DeepSeek V4/V3.x, Kimi K2, GLM-4.5+, Qwen3, GPT-5, gpt-oss, Claude, MiniMax, Grok, Llama 4, Gemma 3). `deepseek-chat`은 공식 문서 기준 128K로 바뀌었다. 이름 추정값만으로는 Skill 예산·입력 한도 초과를 하드 실패시키지 않고 경고한다. 수동·카탈로그·제공자 값은 그대로 차단 근거다.
- **LIBRA 리콜**: 리콜 전 분기 검증이 스코프 큐 뒤에 줄을 서서, Micro/분석 작업이 큐를 약 90초 점유하는 동안 6초 제한으로 리콜 전체가 중단됐다. 큐가 바쁘면 1.5초(유휴 4초) 뒤, 각 정본의 원문 5턴 다이제스트(또는 승인된 원문 수정 보존)를 직접 확인한 읽기 전용 사본으로 리콜한다. 확인되지 않은 정본은 제외하며 아무것도 쓰지 않는다. 직렬 검증은 계속 실행되어 저장한다.
- **LIBRA 모드 게시 재관찰**: 시작 직후 `READ_ROUTE_MODE_PUBLICATION_UNAVAILABLE`. unsettled/conflict 재관찰을 40/80ms 2회에서 40/80/120ms… 8회(약 0.84초)로 늘렸다. SDK 원본과 LIBRA 내장본이 같다.
- **LIBRA 렌즈**: 서버 DB에서 현재 스코프의 세 렌즈 모두 T26–T30까지 `succeeded`이고 기록·벡터가 저장되어 있었다. 실패 표시는 GUI가 캐시 화면(`hydratedAt: 0`)을 계속 보여 준 결과로 판단했다. 아래 GUI 수정으로 다룬다.
- **LIBRA GUI**: 설정·임베딩·스냅샷(느린 상태 재검증 포함)이 모두 끝나야 한 번 다시 그렸다. 원장과 현재 턴을 읽는 즉시 목록을 그리고, 상태 추적 검증은 이어서 반영한다.
- **HAYAKU 리콜·누락 복구**: 리콜 readset이 1.3MB 원장을 1.5초 제한으로 읽어 `HAYAKU_READSET_STORAGE_UNAVAILABLE`로 거부했다. 리콜이 빠지면 패킷 지시도 빠져 T29–T31 패킷이 누락됐다. 복구 증거·원장 읽기와 쓰기 readback도 같은 제한에 걸렸다(`host_timeout` 20건). 저장소 I/O에만 6초 제한을 따로 적용했다. 다른 호스트 API는 1.5초 그대로이고 요청 전체 30초 한도도 유지한다.
- **HAYAKU GUI 노선도**: 열 때 대조 결과를 지우고 원장 패킷만으로 그린 뒤, 느린 부채 점검이 끝나야 누락을 표시했다. 이미 읽은 원장과 현재 채팅으로 정확한 턴 대조를 바로 계산해 처음부터 누락을 표시한다(저장소 읽기·쓰기 없음). 부채 점검이 끝나면 전체 결과로 바꾼다.
- **Flashback 임베딩 차단**: 자동 임베딩 패스의 마감이 패스 시작부터 계산되어, 느린 호스트에서 스코프 로딩만으로 소진됐다. 요청은 전송 전 2ms 만에 `TIMEOUT`이 되었고 11건이 대기로 남았다. 호출자 마감이 없으면 대상 탐색이 끝난 뒤 마감을 시작한다. 전송 전 타임아웃은 5초 간격으로 최대 3회 다시 예약한다. 명시적 유지보수 마감은 그대로다.

## 검증

- 신규: `tests/gradia/input-choice-envelope.test.cjs`, `tests/libra_recall_branch_readonly_fallback_test.cjs`, `flashback_maintenance_preparation_budget_test.cjs`의 느린 탐색 시나리오(수정 전 실패·수정 후 통과), `hayaku_storage_read_coalescing_test.cjs`의 1.8초 전송, `model-context-heuristic.test.cjs`의 계열별·추정값 비차단 시험.
- 통과: GRADIA 단위 499/502(실패 3건은 `jsdom` 미설치로 HEAD에서도 동일), LIBRA read context 22, recall diagnostic 6, scheduled audit 10, capture lifecycle 11, Flashback 유지보수·예산·청크 복구·세계선·비용 29, HAYAKU 복구 저널·관제·패킷·유지보수 UI·원장 읽기.
- 테스트 실행에는 `NODE_PATH=PROGRAM/build-support/node_modules`가 필요하다.
- HEAD에서도 실패하는 기존 실패: `gradia_optional_memory_runtime_test`(전달 대기 시간 초과), `hayaku_gui_ux_contract_test`, `hayaku_gui_workspace_v346_runtime_test`, `compute_gui_and_libra_open_latency_contract_test`, `libra_gradia_lens_ipc_runtime_test` server_only, `authority_route_lifecycle_basic`(Windows fsync EPERM), `libra_approved_revision_background_audit_test` 1건.

## 한계

실제 RisuAI/Tauri와 제공자 호출은 다시 실행하지 않았다. Flashback 리콜의 20초 준비 제한(세계선 동기화·캡처 대조 19초 초과)은 같은 전송 병목의 결과이며, 이번 패치는 그 제한 자체를 바꾸지 않았다. 근본 해결은 플러그인↔서버 전송 경로(대용량 값의 `nativeFetch`) 개선이 필요하다.

## 추가: 리콜 제한 시간 +10초 (사용자 요청)

각 플러그인에 `RECALL_TIMEOUT_EXTENSION_MS = 10000`(GRADIA는 `MEMORY_READ_TIMEOUT_EXTENSION_MS`)을 두고 리콜 경로의 기존 제한마다 더했다.

- **LIBRA**: 리콜 전체 30→40초, 단계 기본 20→30초, 쿼리 임베딩 3.5→13.5초(적응 상한 12→22초), beforeRequest 단계 settings 1.2→11.2초·context 1.8→11.8초·pending boundary 1.6→11.6초(복구·arm 각각)·branch reconcile 6→16초·native copy 0.8→10.8초·manifest 0.9→10.9초·receipt dialogue 1.5→11.5초(내부 1.4→11.4초).
- **HAYAKU**: beforeRequest 예산 fast/balanced/deep 10/20/30→20/30/40초, 호스트 API 1.5→11.5초, 저장소 I/O 6→16초, 요청 마감 30→40초.
- **Flashback**: 요청 훅 리콜 제한 기본·최대 20→30초(설정 화면 최대도 30초), 쿼리 임베딩 1.5~4→11.5~14초. 기본값(20초)을 쓰던 설정은 자동으로 30초가 된다. 직접 다른 값을 저장한 경우 그 값을 유지한다.
- **GRADIA 기억 읽기**: 읽기 세션 30→40초, owner 응답 확인 3→13초, 통합 읽기 요청 10→20초, 플러그인 IPC 읽기 25→35초, 읽기 전 재연결 대기 4→14초. 플러그인 IPC 팩토리에 `describeTimeoutMs` 옵션을 추가하고 `tools/sync_gradia_plugin_read.cjs --write`로 네 플러그인의 생성본을 다시 맞췄다.
- 변경하지 않음: LIBRA 분기 검증의 큐 대기(1.5/4초)는 실패 제한이 아니라 읽기 전용 검증으로 넘어가는 시점이다. 늘리면 리콜이 그만큼 늦어질 뿐이다. 모드 게시 재관찰(0.84초)은 재시도 간격이다.
