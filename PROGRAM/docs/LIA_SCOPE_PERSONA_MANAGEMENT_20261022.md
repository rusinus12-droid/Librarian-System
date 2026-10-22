# LIA 전체 스코프 · Persona 관리

LIA 왼쪽 메뉴와 모바일 하단 메뉴의 **스코프 · Persona**에서 전체 채팅의 실제 Persona 연결을 확인한다. 서버 관리는 포함하지 않으며 LIA의 local_only 정책을 유지한다.

- 캐릭터·채팅, 현재 적용 Persona, 원본 Persona, 짧은 소개와 연결 상태를 표시한다.
- 전체/연결/기본 Persona/확인 필요 필터, 이름·스코프 검색과 24개 단위 페이지 이동을 제공한다.
- 적용 전 선택한 채팅과 변경 대상을 확인한다. 기본 Persona 선택, 다른 채팅, 원본 Persona는 변경하지 않는다.
- 기존 Persona 선택 관리자를 사용한다. LIA 갱신 연결 중인 채팅은 원본을 변경하면 해당 채팅의 Live 복사본을 연결한다. 일반 채팅은 선택한 Persona를 직접 연결한다.
- ‘기본 Persona 사용 · 연결 해제’는 해당 채팅의 명시적 연결을 해제한다. 기존 LIA 기록과 Live Persona는 보존하며 갱신은 일시정지한다.
- 목록을 열거나 연결을 바꿀 때 분석·임베딩·LLM 호출을 하지 않는다. Persona 갱신은 기존 수동 분석 절차를 유지한다.

변경은 목록의 인덱스가 아니라 안정적인 캐릭터·채팅 ID로 대상을 다시 찾는다. 저장 직전 대상과 연결 상태를 재확인하고, 기존 저장·재확인 절차를 거친 결과를 다시 읽는다. 목록을 본 뒤 연결 또는 선택한 Persona가 변경됐거나, ID가 중복됐거나, 다른 채팅의 Live Persona인 경우 적용을 거부한다. 저장된 연결 기록만 남은 스코프와 손상된 기록은 사유와 함께 읽기 전용으로 보존한다. 미완료 연결 변경은 이 화면에서 덮어쓰지 않는다.

검증:

- `lia_scope_persona_management_runtime_test.cjs`: 전체 목록의 읽기 전용 동작, 비활성 채팅 변경/해제, 관리 중인 Live 변경, 원본·다른 채팅·기본 Persona 보존, 오래된 목록과 중복 ID/권한/저장 실패의 거부.
- `browser/lia_scope_persona_management_browser_test.cjs`: 실제 제품 UI, 31개 채팅의 검색·페이지 이동·적용, 외부 Live 제외, HTML 이스케이프, 미저장 설정 보존, 1280/820/390px 화면.
- 기존 binding transaction, concurrent RMW, persona database guard/read UI, manual analysis, commit recovery, pocket GUI 회귀 시험.

저장 직전 캐릭터를 다시 읽는 동안 채팅 순서가 바뀌어도, 해당 인덱스의 실제 채팅 ID가 일치하는 경우에만 쓴다. 이때 함께 확인한 최신 채팅 필드를 보존하고, Persona 바인딩이 바뀌었으면 저장을 거부한다. 순서 변경·동시 필드 수정·동시 바인딩 변경 회귀 시험을 포함한다.

버전: LIA 0.27.2.
