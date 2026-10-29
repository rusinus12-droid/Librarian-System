# 패킷 숨김 복원·캡처 failover·리콜 경로·GRADIA 결과 화면 — 2026-10-30

## 근거

2026-10-29 22:0x UTC 디버그 4종(HAYAKU 3.3.8, Flashback 1.3.8, LIBRA 2.6.8, GRADIA 0.28.2)과 사용자 화면을 대조했다. 사용자 DATA는 변경하지 않았다.

## 원인과 수정

- **HAYAKU 패킷이 화면에 노출**: 패킷 자체는 정상 저장되었다(`finalized_live_chat`, 레코드 승인 complete). 모델은 쓰기 계약대로 bare marker(`HAYAKU_STATE_PACKET_START … END`)로 썼다. 이 세션에서 호스트가 HAYAKU의 display/output/chat-output 핸들러를 한 번도 호출하지 않아(display 0회, chat-output은 30초 뒤 failover) 표시 스크러버가 동작하지 않았다. afterRequest(실행됨)에서 완전한 bare 패킷을 `<!-- … -->`로 감싸 호스트 렌더러가 직접 숨기게 한다. 두 마커는 그대로 남아 패킷 스캐너는 같은 본문을 읽는다. 이미 주석 안에 있거나 불완전한 패킷, 또는 `-->`/`<!--`를 포함해 주석을 깨뜨릴 수 있는 본문은 건드리지 않는다. chat-output failover 시 display 핸들러가 한 번도 실행되지 않았으면 다시 등록한다.
- **Flashback 원문 캡처 실패**: Flashback의 chat-output 리스너도 이벤트 0회였다. LIBRA·HAYAKU는 afterRequest 뒤 타이머로 failover하지만, Flashback은 다음 요청에서만 확인해 T32가 캡처되지 않았다. 같은 30초 타이머 failover를 추가했다. failover는 기존 경로로 대기 턴의 live-chat 캡처 모니터를 예약한다. 리스너는 모든 플러그인에서 동기 반환한다. 지연은 호스트의 순차·교차 iframe 디스패치에서 생긴다.
- **Flashback 리콜 실패**: 세계선 읽기 단계는 약 3.5초에 끝났다. 이후 기록하지 않던 쓰기 단계(전체 샤드 copy-on-write 커밋, 세계선, 매니페스트)가 약 23초 걸려 30초 준비 제한을 넘겼다. 이 비용은 새 턴 하나의 계보 주석 때문에 생긴다. 재조정이 추가 전용(저장된 레코드의 은퇴·격리·복원 없음)이면 저장된 레코드의 리콜 상태가 이미 정확하므로, 요청 훅은 쓰기를 기다리지 않고 리콜하고 전체 동기화를 백그라운드(리콜 뒤 실행)로 넘긴다. 리롤·롤백 등 상태가 바뀌는 경우는 이전처럼 쓰기를 마친 뒤 리콜한다. `save_records`/`save_worldline` 단계도 진단에 기록한다.
- **LIBRA 리콜 실패 · 라우팅 표 단일 기준화**: `READ_ROUTE_MODE_PUBLICATION_UNAVAILABLE`, status `conflict`, 9회 재관찰 후에도 지속. 라우팅 표(채팅별 저장 위치)는 서버 모드에서도 서버 접속 전에 읽어야 하므로 로컬에 둔다. pluginStorage와 기기 로컬 저장소에 같은 내용을 쓰고 서버에도 사본을 둔다(이 채팅은 2026-10-24부터 `server_only`, 서버 사본 revision 386 settled). 쓰기는 두 로컬 사본 중 하나만 성공해도 성공으로 처리했지만, 리콜 직전 검사는 두 로컬 사본의 게시 기록이 완전히 같아야 통과했다. 그래서 한쪽 쓰기가 실패하면 다음 라우팅 저장 전까지 리콜이 계속 실패했다(어느 쪽이 왜 실패했는지는 이번 데이터로 특정할 수 없다). 이제 pluginStorage 사본이 기준이다. 쓰기 성공은 pluginStorage 기록·재확인으로 판정하고, 기기 사본은 비상용으로 계속 쓴다(pluginStorage가 없을 때만 성공 기준). 일반 로딩과 리콜 검사는 pluginStorage만 읽는다. pluginStorage 사본이 없으면 기기 사본, 둘 다 없으면 서버 사본(서버 주소가 연결된 경우 세션당 1회)을 읽고, 복구한 표를 일반 쓰기 경로로 pluginStorage에 다시 쓴다(동시 1회, 실패 시 1분 대기). 전역 모드 전환 재확인도 기준 사본만 검사한다. 앞선 "두 사본 행 일치 시 진행" 예외는 제거했다. SDK 원본과 LIBRA 내장본이 같다.
- **LIBRA 미크로**: T32 Micro는 실제로 `verified`로 저장되었다(응답 후 약 3.5분). 실패로 보인 것은 지연과 GUI 갱신 지연 때문으로 판단했다.
- **LIBRA 인물·세계·서사 탭 지연**: 탭은 검증된 상태 투영이 없으면 저장된 head를 읽는다. 연속성 상태를 읽는 즉시 두 번째 임시 스냅샷을 게시해 탭을 먼저 그리고, 검증된 투영(미확정 표시)은 readback 뒤 교체한다.
- **GRADIA 기억 미사용**: 연결 자체는 자동 재연결로 복구되었다. 이번에는 현재 입력이 프리셋 `Current Input` 래퍼(호스트 메시지 id 없음)에서 해석되어 `LIB_READ_NATIVE_ID_UNAVAILABLE`로 거부되었다. 래퍼 본문과 정확히 일치하는 호스트 사용자 메시지가 정확히 하나일 때만 그 메시지에 결속한다. 그 외에는 계속 거부한다. 로어 38, Skill 2, 페르소나·캐릭터 정의, 최근 8턴은 정상 사용되었다.
- **GRADIA 인풋 선택 레이아웃**: 원본 입력 `<pre>`가 줄바꿈하지 않아 한 줄이 그리드를 넓혀 모든 카드가 대화상자 밖으로 밀렸다. 대화상자 안의 텍스트 영역은 줄바꿈하고 항목 최소 폭을 0으로, 버튼·배지 행은 줄바꿈되게 했다.
- **GRADIA 실행 결과 화면**: 초안과 AIDE 결과를 `resultText`로 JSON 문자열 그대로 넣어 `\n`이 보이고 칸을 넘쳤다. SHADOW ACT은 읽을 수 있는 초안과 자료 영역으로 나눴다. 자료는 기억(LIBRA·HAYAKU·Flashback별 항목·미리보기), 페르소나·캐릭터 정의, 로어, 대화·문맥, Skill·품질 규칙, 참조 예산으로 묶었다. 각 AIDE는 분석(요약·조건·위험·수정 지시), 초안 수정 내역(작업·대상·이유·추가 문장, 적용 수·문단 변화), 수정 후 초안을 보여 준다. 기억 항목 목록은 읽기 선택 결과에 표시용 요약(owner·출처·글자 수·220자 미리보기)을 추가해 얻는다. 새 읽기는 없다.

## 검증

- 신규: `hayaku_bare_packet_conceal_test.cjs`(3), `gradia_results_view_gui_test.cjs`(jsdom 실제 화면), `chat_output_listener_sequential_dispatch_contract_test.cjs`의 Flashback failover·지연 커밋 계약. `libra_routing_primary_copy_test.cjs`(어긋나거나 깨진 기기 사본 무시, pluginStorage 부재 시 기기 사본 사용, 기기 사본에서 pluginStorage 복원. 1·3번은 수정 전 코드에서 실패).
- 지난 커밋 이후 오래된 계약 정규식 3개(`6000 + RECALL_TIMEOUT_EXTENSION_MS`, ledger 기반 never-sent, presentation 기반 health)를 현재 코드에 맞췄다. 16초 저장 제한 때문에 실패하던 `hayaku_capture_delta_runtime_test` 대기 시간도 늘렸다.
- 통과: GRADIA 단위 533/534(HEAD와 같은 1건), 3-owner consumer/pipeline, HAYAKU/Flashback read session, LIBRA read context 22, recall branch/diagnostic, capture lifecycle, Flashback 세계선·청크·예산·unload 계열, HAYAKU 복구 저널·패킷 승인·Gemma 패킷.
- HEAD에서도 같은 실패: `gradia_plugin_read_runtime_test`, `gradia_input_writer_unified_runtime_test` 1건, `libra_gradia_unified_pipeline_runtime_test`, `gradia_suite_test`.

## 한계

실제 RisuAI에서 재현하지 않았다. 호스트가 HAYAKU 스크립트 핸들러를 호출하지 않은 근본 원인(호스트 측 디스패치)은 플러그인에서 고칠 수 없다. 이번 수정은 숨김을 afterRequest 반환값으로 옮겨 그 경로에 의존하지 않게 한다. 이미 화면에 노출된 T32 메시지는 표시 핸들러가 다시 동작하거나 메시지를 다시 저장할 때 숨겨진다. Flashback의 copy-on-write 쓰기 비용 자체는 줄이지 않았다.

## 추가: 라우팅 표 단일 기준을 RETRACE·HAYAKU·Flashback·GRADIA에 적용

LIBRA에 적용한 원칙을 공용 저장 클라이언트(`sdk/MemorySuiteStorageClient.source.js`)와 이를 포함하는 RETRACE·HAYAKU·Flashback·GRADIA·LIA에 똑같이 적용했다. HAYAKU·Flashback은 SDK를 그대로 포함하며 일치를 확인했다. RETRACE·GRADIA·LIA는 변형본이지만 해당 블록은 같다. LIA는 서버를 쓰지 않으므로 서버 사본 복원은 동작하지 않고(서버 주소 미연결), pluginStorage 기준·기기 사본 백업·기기 사본 복원만 적용된다. LIA에는 Flashback용 `finalizeScopeTransition`을 추가하지 않았다.

- 일반 로딩은 pluginStorage 사본만 읽는다. 없으면 기기 사본, 둘 다 없으면 서버 사본(서버 주소가 연결된 경우 세션당 1회)을 읽고, 복구한 표를 일반 쓰기 경로로 pluginStorage에 다시 쓴다.
- 쓰기 성공은 pluginStorage 기록·재확인으로 판정한다. 기기 사본은 비상용 백업이다(pluginStorage가 없을 때만 성공 기준).
- 상태 점검(`HEALTH_ROUTE_*`)과 GRADIA의 기억 읽기 라우팅 확인(`LIB_READ_ROUTE_*`)은 pluginStorage 사본만 읽는다. 기기 사본은 그 사본이 없을 때만 읽는다. 기기 저장소를 열 수 없거나 기기 사본이 깨졌다는 이유로 더 이상 거부하지 않는다.
- Flashback 서버 동기화 완료 처리가 두 저장소의 라우팅 표를 각각 직접 고쳐 쓰던 경로를 없앴다. 대신 새 브리지 메서드 `finalizeScopeTransition`을 사용한다. 이 메서드는 `transition_pending` 행만 기록된 대상 모드로 확정하고 이전(마이그레이션)을 시작하지 않는다. 일반 쓰기 경로와 서버 게시를 거치고 `pendingTargetMode`를 비운다. 서버 사본도 이제 함께 갱신된다.
- 검증: `sdk_routing_primary_copy_test.cjs`(4, 그중 2개는 수정 전 SDK에서 실패), `flashback_server_mode_recovery_test`(전환 확정 후 `pendingTargetMode=null`), 라우팅·전역 전환·스코프 관리·RETRACE·GRADIA 3-owner 계열 회귀 통과.
