# GRADIA의 LIBRA 통합 기억·렌즈 기억 읽기

날짜: 2026-10-22

## 연결 경로

- 플러그인 모드: GRADIA → RisuAI plugin channel → LIBRA 소유자 읽기 → 통합 기억과 렌즈 참고 메모.
- 서버 모드: GRADIA → 기존 unified read channel → 서버에 연결된 LIBRA 소유자 읽기 → 같은 두 기억.
- 렌즈는 비정본 참고 메모로 표시하며 정본 기억 우선 안내를 함께 전달한다. 통합 기억의 원래 compiler packet과 검증 권한은 소유자 내부에 보관한다.
- 한 요청의 문자·바이트 한도 안에서 렌즈 예산을 예약한다. 다단계 세션의 누적 원문 읽기는 최대 256 MiB·32768회로 제한한다(모델 전달 예산이나 동시 보유 메모리 한도를 늘리지 않음). 읽기는 렌즈 분석, 벡터 갱신 및 삭제 작업을 시작하지 않는다.
- 스코프, 완료 대화 원문, 렌즈 설정·기록·승계 자료·인물 레지스트리·임베딩 설정의 변경을 단계 사이와 최종 전달 전에 확인한다. 변경 시 해당 요청의 근거 및 초안을 폐기한다.

## RisuAI IPC 확인 범위

기준 커밋: 02a83695d81eb4e083453c4524b8c7d463df95aa.

[호스트 구현](https://github.com/kwaroran/Risuai/blob/02a83695d81eb4e083453c4524b8c7d463df95aa/src/ts/plugins/apiV3/v3.svelte.ts)의 addPluginChannelListener, postPluginChannelMessage 함수를 테스트 호스트에서 실행한다. TypeScript 매개변수 타입만 제거한다. 호스트는 송수신 플러그인의 allowedIPC를 모두 확인하며 실제 발신자를 메타데이터에 넣는다. 콜백 완료는 기다리지 않는다.

실제 LIBRA·GRADIA 스크립트의 allowed-ipc 선언을 읽어 사용한다. 양쪽 선언이 일치하며 외부에서 플러그인 저장소를 직접 읽는 API를 가정하지 않는다. LIBRA가 소유 데이터를 읽고 검증한 결과를 채널로 반환한다.

사용자 PC에 설치된 RisuAI 자체를 실행한 검증은 아니다. 설치 버전·플러그인 이름·호스트 권한이 기준 구현과 일치해야 한다.

## 저장 목록의 물리 해시 재사용

기존 점진 검증은 정본 목록이 의미상 같으면 오래된 물리 해시를 재사용할 수 있었다. 공통 원본 키의 실제 바이트가 달라지면 기존 corpus의 열기를 거부한다. 빌드할 때는 첫 window를 새로 투영해 공유 자료와 물리 해시를 함께 갱신하고, 검증된 나머지 window만 재사용한다. 원문 변경을 무시하거나 기존 그래프에 새 해시만 붙이지 않는다.

## 관련 검증

- libra_gradia_lens_ipc_runtime_test.cjs: 실제 플러그인과 upstream 호스트 채널 함수, 두 저장 모드, 네 모델 단계의 통합·렌즈 근거, 설정 변경에 따른 중단, 상호 IPC 권한.
- libra_memory_graph_incremental_currentness_runtime_test.cjs: 기존 점진 재사용, 실제 소비 원문 변경 거부 및 전체 감사.
- 기존 unified owner/source, plugin read, 렌즈 의미 검색 및 전체 파이프라인 회귀 시험.
