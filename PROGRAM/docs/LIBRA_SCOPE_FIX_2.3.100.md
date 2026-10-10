# LIBRA 2.3.100 스코프 참조 수정

- GRADIA 응답 보호: 접근 불가능한 digest 대신 같은 createTextHasher로 원문/대체문 해시 생성.
- 구형 관계 편집: 관계 차원 상수를 코어와 GUI가 함께 접근하는 상위 스코프로 이동. 허용 값은 유지.
- 테마 연결: 기존 getLiveApi로 getColorScheme 지원 호스트 선택.
- UI 중복 등록: 스코프 밖 string 대신 String 사용.
- 캡처 무응답 자동 전환: expectedScope 객체 검증 후 safeClone, 공개된 LibraMemoryCore.scheduleScan을 사용. scope 및 autoAnalyze 조건 유지.

검증: 전체 배포 JS 문법 통과. 5개 실제 오류 분기의 Chromium 회귀 검사에서 해시 기록·대체문 반환, 관계 차원 선택지, 중복/일반 오류 분리, 실제 테마 API 선택, 복구 scan serial 증가 확인. 열람대와 작성실 회귀 5개 통과. GRADIA runtime hardening 검사 통과(낡은 버전 고정 assertion만 현재 버전으로 갱신). AST 스코프 재검사에서 이번 오류 참조가 모두 제거됨. 실제 RisuAI/provider 검증은 미실시.
