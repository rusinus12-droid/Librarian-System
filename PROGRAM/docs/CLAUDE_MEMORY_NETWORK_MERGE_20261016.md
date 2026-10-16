# 클로드 기준 브랜치와 메모리 네트워크 병합

작성: 2026-10-16 (한국 시간).

## 기준과 범위

이후 작업의 기준 브랜치는 `claude/usability-improvements-products-23ax1n`이다. 이 브랜치의 `af55f2f`를 첫 번째 부모로 유지하고, `codex/libra-memory-network-20261013`의 `37fbfed`를 병합한다. 공통 기반은 `4531fda`다.

클로드 쪽 UI 정리, HAYAKU 패킷 안전망·다국어 별칭, Flashback 하이브리드/키워드 fallback, GRADIA 관련도 정렬·선형 포장과 평가 도구를 유지한다. 메모리 네트워크 쪽의 세 owner 전용 읽기 IPC, GRADIA 일반 생성·인풋 작성기 연결, native scope·원본·저장 모드 검증, owner 세션 읽기 횟수 예산을 함께 적용한다.

실행 소스는 자동 병합됐으며 충돌은 `program-manifest.json`, `SHA256SUMS.txt` 두 생성 파일에 있었다. 클로드 매니페스트를 기반으로 병합된 소스에서 두 파일을 재생성했다. 매니페스트 생성기의 `promptSelection` 설명도 실제 관련도 정렬 순서로 갱신했다.

세부 계약은 [최근 챗과 플러그인 IPC](gradia/RECENT-CHAT-AND-PLUGIN-IPC-20261015.md), [RAG 개선·평가](RAG_EVAL_HYBRID_FALLBACK_20261015.md)를 따른다.

## 검증

병합된 실제 플러그인 세 개와 GRADIA를 함께 로드하는 `gradia_plugin_read_runtime_test.cjs`에서, owner Before Request를 먼저 실행하지 않고 네 단계 생성·인풋 작성기에 세 owner의 근거가 전달되는 것을 확인했다. 원본 변경 후 다음 전달을 막는 검사도 포함한다. 별도로 읽기 IPC, snapshot, 관련도 정렬·포장, HAYAKU 패킷 안전망·설정 UI, 최근 턴, 서버 연결·모델 예산 회귀를 확인한다.

- 네 플러그인의 Full/Min 8개 산출물 생성·구문 검사 및 Full과 병합 소스의 바이트 일치 확인.
- 실제 세 owner IPC 통합: 소스 실행과 GRADIA Min 실행 모두 통과. SQLite 서버 기반 Shadow/Aide 및 인풋 작성기 회귀 2개도 통과.
- 읽기 IPC 6개, snapshot 4개, 관련도 정렬·포장 3개, 패킷 안전망 2개, 설정 UI, 최근 턴 21개, 서버 연결 25개, 모델 예산 9개, 서버 읽기 adapter 50개 통과.
- HAYAKU 교차 언어 평가와 Flashback RAG floor 통과. Flashback의 합성 평가 적중률은 정상 0.938, provider 오류 시 키워드 대체 0.688이다.
- 네 플러그인 소스에서 `4531fda → af55f2f`와 `37fbfed → 병합 결과`의 stable patch ID가 같아 클로드의 실행 코드 변경이 보존됐음을 확인했다.

모델 응답과 provider는 합성 fixture를 사용한다. 실제 설치 호스트에서의 품질·지연·채널 허용 UI 인증을 의미하지 않는다.

## 남아 있는 리뷰 과제

병합과 별도로 다음 검토 사항은 유지한다.

- P2: HAYAKU 백그라운드 복구의 자동 승인 직전에 최신 journal의 복구 시도·실패 상태를 다시 확인해야 한다.
- P2: Flashback query embedding deadline이 실제 provider 작업 취소와 늦은 결과의 게시 수명에도 연결돼야 한다.
- P3: HAYAKU 진단에서 후보 작성 성공과 durable 기억 복구 완료를 구분해 표시해야 한다.
