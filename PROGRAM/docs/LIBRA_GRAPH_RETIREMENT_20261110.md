# LIBRA 그래프 검색 엔진 철거

작업 브랜치: `codex/libra-state-first-memory-engine`.
main의 원래 내용은 별도 폴더에 백업되어 있으며 이 작업으로 변경하지 않는다.

## 제거 범위

- 상설 그래프 구축·게시·검색·증분·임대·GC 코어와 동기화 도구.
- 옛 memory network 팩토리. 공용 SHA256은 독립된 작은 fingerprint 모듈로 제공한다.
- 폐기 안내만 하던 그래프 API도 제거한다. 새 API는 직접 검색을 제공한다.
- 서버 `/v1/libra/graph-lifecycle`, 그래프 capability, 그래프 전용 쓰기 임대 검사.
- LIBRA Storage SDK의 그래프 임대·갱신·forest 지원 검사와 관련 타이머.
- GUI의 그래프 구축·구조 화면, 연관 그래프 패널, 그래프 복구 문구와 옛 진단 항목.
- 플러그인 빌드 및 배포 목록의 그래프 의존성과 상설 그래프 배포 계약.
- 폐기한 그래프 기능 전용 도구 22개·테스트/fixture 79개·서버 모듈 1개, 총 102개 파일.

현재 검색에서 재사용하는 fixture는 `libra_direct_memory_reader_fixture.cjs`로 이름을
바꿨으며, GRADIA 등 공용 테스트와 평가 도구의 참조도 바꿨다.
기존 그래프 테스트를 새 엔진의 통과 결과로 취급하지 않는다.
상설 그래프 게시와 구 owner receipt 경로를 전제로 한 통합 테스트도 이 폐기 목록에 포함한다.
현재 소유자 검증은 State 투영·GRADIA 소유자 계약·세 플러그인 읽기·렌즈 IPC 테스트로 검증한다.

## 유지 범위

정본·Micro·State·렌즈의 생산과 원문/승인 검증, 세계선·휴대 백업 및 GRADIA
읽기 프로토콜은 유지한다. 따라서 저장된 `unified_*` 스키마와 프로토콜의
`unified_engine` 식별자, 원문·백업 간 관계를 검증하는 데이터 구조는 남는다.
이들은 상설 검색 그래프를 생성하거나 게시하는 기능이 아니다.

일반 원문 읽기 캐시는 유지하되 `nativeReadFrames` 등 실제 역할에 맞게 이름을
정리했다. 기존 사용자 저장소의 그래프 자료를 자동 삭제하거나 초기화하지 않는다.
삭제한 코드의 과거 상태는 Git 이력과 main 백업에서 확인할 수 있다.

## 검증

- 현재 검색·State 투영·렌즈·GRADIA 소유자 계약 및 엔진 모드 테스트.
- 그래프 API·서버 capability 부재 및 삭제된 HTTP 경로의 404를 실제 런타임으로 확인.
- 실제 ZIP에서 서버 의존성 폐쇄 검사, release builder profile 검사.
- LIBRA Full 소스 빌드 및 문법 검사. 과거 크기 기준 초과는 빌드 도구의 보고용 경고다.
- 실제 RisuAI UI 및 외부 모델·원격 서버 실행은 검증 범위에 포함하지 않는다.

최종 결과: 현재 경로 회귀 테스트 56개, 로컬 HTTP/SQLite를 사용하는 SDK 조건부 쓰기
검증 16개, ZIP 의존성 폐쇄 및 release builder profile 검사를 통과했다.
LIBRA Full 빌드와 4개 플러그인·서버 문법 검사, 세 소스 동기화 검사,
`git diff --check`도 통과했다. 폐기한 그래프 테스트는 이 통과 수에 포함하지 않는다.

로그와 삭제 목록은 `.development/graph-retirement/`에 보관한다.

## 후속 삭제 (2026-11-11)

- `plugins/LIBRA.js`: 참조가 없던 옛 검색 상수 48개(recall catalog·연관 회상·BM25F/RRF 가중치·
  hydrate/latent/temporal·질의 임베딩 예산), 폐기 안내만 하던 `getAssociativeRecallDiagnostics`,
  회상 래퍼의 창/커서/lane 인자와 `unifiedMemoryEngine` 진단(`legacyRankerExecuted` 등 옛 전환 표식),
  무시되던 `loreShare` 인자. 저장된 설정의 엔진 선택 이행 코드는 유지한다.
- 회수 진단 화면의 page·frontier·window·`durable_common_index` 항목.
- 구 통합 엔진·상설 그래프 설계/계약/현황 문서 27개와 검증·측정 JSON 2개.
- 삭제된 API만 검증하던 테스트 5개(연관 회상 폐기 계약 3, 질의 임베딩 예산, volatile 색인).
- 평가 도구의 그래프 색인 구축 단계(`--corpus-index`, `--index-rebuilds`).
