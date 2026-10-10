# MemorySuite 통합 설계 v1.4 — 6차 지원 상태

2026-09-07 KST / MemorySuite 0.3.32 · LIBRA 2.3.39. 원 v1.1과 v1.2/v1.3의 불변 조건은 유지한다.
이번 버전은 실호스트/실모델/통합 서버 writer까지 완성된 최종 운영 인증본이 아니다.

| 영역 | 실제 코드 범위 | 남은 경계 |
|---|---|---|
| 인물 split | fact-role 명시 배정, 현재 교정 journal, Registry/typed 참조 재생, 실제 GUI | person/all-v4 검증 가능 범위; 장소/조직·미해석 legacy의 임의 분할 불가 |
| Legacy 전환 | 현재 세션의 승인 evidence 구간 선택 재분석, 명시 sparse gaps, 이전 revision 보존 | inherited 원본 archive 직접 수정 불가, 증거 부재/현재 수정은 별도 승인 |
| 보관 자료 | 참조 그래프 조사, 만료 미참조 임시 basis만 명시 삭제 | 정본/원문/archive/교정 영구 자료 GC는 하지 않음 |
| 서버 원자 기반 | 단일 namespace 조건부 다중 키·영수증 SQLite transaction | SDK/모든 unified writer 통합 전. server/mirror는 계속 차단 |
| WM 의미 | 사전 16개 표본·A/B/C 실제 파이프라인 runner, 기존 prompt 경계 보강 | 이번 외부 모델 호출 0회, 인간 의미 평가 미실행 |
| 실호스트 | 제공 RisuAI 소스 확인·의존성 설치 시도 | DNS 실패로 앱/iframe/IPC 미실행 |
| 응답/설정 | 기존 read-only snapshot·Provider·BOOK_UX·기본 legacy 보존 | 실검수 후에만 기본 전환 판정 |

GUI 테스트·Node 실제 배포 코드·실제 HTTP/SQLite 테스트·실제 RisuAI·실제 외부 모델 결과는 서로 다른 증거 수준으로 구분한다.
6차 완료라며 not_run 항목을 PASS로 바꾸지 않는다. 정확한 실행 결과/해시는 외부 6차 보고서·evidence를 따른다.
