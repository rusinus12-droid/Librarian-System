# GRADIA 최근 챗과 플러그인 기억 읽기

갱신: 2026-10-15. 대상: GRADIA 0.25.85, LIBRA 2.3.150, HAYAKU 3.0.139, Flashback 1.0.102.

2026-10-16 병합: 클로드 브랜치의 관련도 정렬을 두 읽기 방식에 함께 적용한다. owner별 최근 항목 2개를 먼저 배치하고, 나머지는 현재 입력의 BM25 관련도, 겹침이 없는 항목은 최신순 round robin으로 정렬한다. 항목 전체를 선택하는 예산 검사와 owner 현재성 검사는 유지한다. 평가 범위는 [RAG 개선 문서](../RAG_EVAL_HYBRID_FALLBACK_20261015.md)를 함께 참고한다.

## 최근 챗을 읽는 방법

`buildRecentChat()`는 요청 메시지에서 현재 입력을 분리하고 완료된 U+A 대화 턴을 선택한다. 네이티브 채팅을 읽을 수 있으면 `loadActualChatContextForRag()`와 `applyActualChatContextToRecent()`가 현재 캐릭터·채팅의 저장된 메시지로 최근 문맥을 다시 구성한다. 전처리에서 추가된 회상 문자열을 네이티브 과거 대화의 정본으로 사용하는 방식이 아니다. 네이티브 읽기가 불가능할 때는 요청 메시지로 구성한 문맥을 사용한다.

완료 판정은 출력 이벤트의 동일 scope·메시지·변형·원문 증거 또는 다음 실제 사용자 입력으로 닫힌 대화 경계를 사용한다. 마지막 미확인 출력, 스트리밍 중 출력, 오류·비활성·코멘트는 완료 턴에서 제외한다. 중복 메시지 ID는 마지막 선택 변형만 읽으며, 그룹 대화는 같은 사용자 입력에 대응하는 여러 인물의 출력을 함께 유지한다. 현재 입력은 과거 완료 턴에 다시 넣지 않는다.

Shadow/Aide는 단계별 `turn_window`를 사용한다. 기본 8턴이며 빠르게/균형/꼼꼼 프로필은 각각 4/8/12턴을 제안한다. 설정 가능한 범위는 1–64턴이다. `completeTurnsText`, 직전 턴, 이전 턴들, 마지막 장면의 별도 사본을 만들어 장면 연속성, 로어 활성화·랭킹, 단계 참조 패킷에 사용한다. 진단·템플릿에는 4,200/5,000/6,000자 등 별도 축약본도 존재하므로 화면의 한 문자열을 전체 모델 입력 예산으로 해석하면 안 된다.

최근 턴 선택과 최종 모델 요청은 다른 단계다. 참조 프로필, 단계 참조 설정, 실제 모델 context와 출력 예약에 따라 최종 자료를 포장한다. 외부 기억 추가 때문에 네이티브 최근 턴을 몰래 줄이지 않으며 모델 용량을 검사한다. 상세 예산은 [모델 문맥·전송 예산](MODEL-CONTEXT-BUDGET-20261015.md)을 따른다.

인풋 작성기는 별도의 terminal-only 준비 경로를 사용한다. 일반 Shadow의 완료 8턴 창을 그대로 복사하지 않고 마지막 장면·미제출 제안·허용한 자료로 입력 후보를 만든다. 미제출 제안은 조회 의도이며, 확정된 대화나 기억으로 저장하지 않는다.

## 두 읽기 방식

| 선택 | 자료를 제공하는 경로 | 조건 |
|---|---|---|
| 서버 · 통합 메모리 검색 (`unified_engine`) | 기존 readonly 서버 세션 + LIBRA 통합 엔진 owner 채널 | 기존 server_only, data/reset/readonly 권한 및 scope 조건 |
| 플러그인 · 기억 직접 읽기 (`plugin_ipc`) | GRADIA가 각 owner에 읽기 요청. owner가 자신의 플러그인 저장소를 읽어 응답 | 같은 실제 캐릭터·채팅, 각 owner의 plugin_only, 허용된 IPC 채널 |

플러그인 모드는 자료 화면에서 **플러그인 · 기억 직접 읽기 (IPC)**를 선택하고 **연결**한다. 서버 연결·서버 credential은 필요하지 않다. 공개 API는 `connectLibReadOnly('', 'plugin_ipc')`이다. 기존 서버 동의를 플러그인 읽기 동의로 자동 전환하지 않는다. 장치 로컬에 선택 출처·owner 목록·명시적 연결 여부를 보존하고, 가져오기·연결 해제·출처 재연결은 이전 실행과 초안을 무효화한다.

플러그인이 설치되지 않았거나 채널을 제공하지 않거나 저장 모드가 맞지 않으면 `unavailable`에 표시한다. 연결된 owner 집합은 실행 중 고정한다. 이미 초안에 영향을 준 owner가 사라져도 나머지 자료만으로 이전 초안을 계속 전달하지 않는다. mirror 및 저장 모드 전환 중인 owner는 이 로컬 읽기로 우회하지 않는다.

## owner별 제공 내용

| owner | 제공 내용 | 읽기로 실행하지 않는 작업 |
|---|---|---|
| LIBRA | 정본·Micro·상태·로어를 통합 엔진에서 선택·검증한 하나의 근거 묶음 | 정본 생성, Micro 생산, Before Request 훅 실행 |
| HAYAKU | 게시된 ledger의 선택된 active/historical 패킷, 그 패킷이 가리키는 captureRawRef, 검증된 archive chain | 회복·복사·재분석·ledger 재저장, 임의 receipt 열거 |
| Flashback | 게시된 manifest가 가리키는 response/자동 episode 원문, COW raw-page directory와 검증된 archive chain | 임베딩 생성, 벡터 본문 복사, 원본 채팅 재수집·원본 정리 |

HAYAKU와 Flashback의 저장 형식·체크섬·scope·선택/퇴역·아카이브 검사는 기존 서버 logical reader와 같은 규칙을 사용한다. `sync_gradia_plugin_read.cjs`가 서버 검증기를 비동기 브라우저 읽기로 생성하며, 원본 형태가 달라지면 알려진 변환이 실패하도록 검사한다. gzip은 실제 압축 해제 출력 바이트를 제한한다. 저장소 키 목록을 외부에 제공하지 않는다.

LIBRA의 통합 엔진은 설정에 따라 query embedding을 사용할 수 있다. IPC는 생성 모델을 새로 실행하거나 하야쿠·플래시백의 검색기를 대신 실행하는 요청이 아니다. LIBRA의 파생 공통 인덱스 준비·캐시는 기존 엔진 정책을 따른다.

## 순서, 현재성, 수명

전용 프로토콜은 `memory-suite.gradia-plugin-read.v1`, 채널은 `gradia_memory_read_request_v1` / `gradia_memory_read_response_v1`이다. `describe/capture/current/release`만 제공한다. RE:TRACE의 변경·복구 액션 권한을 GRADIA에 열지 않는다. 네 플러그인에 정확한 peer ID의 `allowed-ipc` 선언을 추가한다. 양방향으로 호스트가 붙인 `metadata.sender`와 요청 ID·액션을 확인한다.

GRADIA는 Before Request의 최후 실행 위치를 요구하지 않는다. 이전 훅의 회상 블록이나 이전 요청 결과를 기다리지 않고, 자기 실행에서 owner 세션을 연다. 따라서 owner 훅이 아직 새 자료를 게시하지 않았다면 마지막으로 게시된 기억을 읽는다. 현재 입력과 최근 네이티브 장면은 별도로 유지한다.

owner는 실제 native scope, 저장 모드·전환 상태, 런타임 경계를 캡처 전후와 각 현재성 검사에서 확인한다. HAYAKU/Flashback은 모든 참조 원문을 다시 읽어 내용 digest를 비교하고, LIBRA는 private compiler authority로 소비한 원본·근거 묶음을 검증한다. 플러그인 로컬 digest를 서버 revision, 물리 트랜잭션 또는 ABA 인증으로 표시하지 않는다. 시작 시 유지보수나 외부 수정이 실제 원본을 바꾸면 해당 실행은 거부될 수 있다.

캡처한 근거는 Shadow/Aide 또는 작성기의 한 실행에만 사용한다. 각 모델 전달 전후·초안 전달 시 현재성을 확인한다. 요청 취소·연결 변경·오류 시 owner receipt와 LIBRA query 자원을 해제한다. owner당 최대 16개의 진행/보존 세션, 10분 TTL, 요청 64KiB, 질의 16KiB를 적용한다. 코퍼스 기본 4MiB/최대 32MiB는 세 owner의 합산 한도다. 원문 항목 단위로 선택하며 모델 예산도 다시 검사한다.

LIBRA의 GRADIA owner 세션은 여러 단계의 반복 검증을 포함하므로 누적 `maxReads`를 32,768회로 설정한다. 일반 query 기본 8,192회와 구분한다. 기존 8,192회에서는 세 owner를 읽는 4단계 실행의 네 번째 모델 응답 뒤 최종 검증이 `LIBRA_GRAPH_RESOURCE_READ_COUNT_BUDGET`으로 중단되는 사례를 재현했다. source/durable 바이트·retained 메모리·동시 읽기 상한은 유지한다. 이는 입력 토큰 또는 생성 예산의 확대가 아니며, 세션의 검증 I/O 상한이다.

## 검증과 남은 호스트 확인

- `gradia_plugin_read_test.cjs`: 인증되지 않은 sender, 누락 owner, 모드·원본 변경, 늦은 완료와 취소, 미제출 제안 계약.
- `gradia_plugin_snapshot_test.cjs`: 브라우저 SHA256/UTF-8, bounded gzip, 선택된 captureRawRef만 읽기, 동시 현재성 검사와 원본 불변성.
- `gradia_plugin_read_runtime_test.cjs`: 실제 세 플러그인과 GRADIA를 독립 저장소로 로드. 해당 입력의 owner Before Request를 호출하지 않고 Shadow/Aide·인풋 작성기 모델 payload에서 세 owner의 자료 확인. 원본 변경 후 초안 차단.
- 기존 최근 턴, 서버 읽기·연결, 모델 예산 및 native LIBRA 파이프라인 회귀를 함께 확인한다.

이 검증은 합성 RisuAI 호스트와 합성 모델 응답을 사용한다. 실제 설치 호스트에서의 IPC 허용 UI, 플러그인 로드/해제·업데이트, 대용량 저장소 지연과 실제 모델 응답 품질은 별도 확인 대상이다.
