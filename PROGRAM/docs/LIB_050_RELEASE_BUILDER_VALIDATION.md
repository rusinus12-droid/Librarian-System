# LIB 0.5.0 릴리즈 빌더 검증

검증일: 2026-10-24 UTC. 기준 커밋: f9d743548b197f261fe33dddf48680ee3f0a9ab3. Node 24.19.0 / Linux.

패키지·서버 버전을 0.4.1에서 0.5.0으로 변경했다. 플러그인 버전과 데이터/업데이터 계약은 유지했다. 버전 선언, portable migration 기본값, 설치 안내, README, provenance, manifest 및 체크섬을 함께 갱신했다.

## 정식 릴리즈 검사

실행: `node PROGRAM/tools/build_distribution.cjs --version 0.5.0 --profile all --output-dir /workspace/lib-release-0.5.0`

결과: release_smoke 단계에서 878개 중 876개 통과, 2개 실패. 취소·건너뜀 0개. 정식 ZIP은 생성되지 않았다. 빌더는 실패 시 버전 변경을 원복했고, 요청한 버전 변경은 검사 종료 후 별도로 다시 적용했다.

- `PROGRAM/tests/program_data_layout_test.cjs:177`: 기존 DATA 이관 receipt의 `legacyDataMigrated`가 예상 true와 달리 false. 이전 작업에서도 확인된 실패다.
- `PROGRAM/tests/storage_transition_gui_recovery_test.cjs:368`: `LIBRA opens directly on settings page during transition` 검증 실패. 서버 복구 패널을 찾은 뒤 settings 페이지가 활성 상태라는 assertion을 통과하지 못했다. 이번 버전 변경으로 생긴 회귀인지 여부는 확정하지 않았다.

로그: `/tmp/lib-release-0.5.0.log`. 실패 보고서는 `/workspace/lib-release-0.5.0/`에 있다. 이 결과를 정식 릴리즈 승인으로 간주하지 않는다.

## 별도 후보 패키징 검사

실행: `node PROGRAM/tools/build_distribution.cjs --profile all --offline --output-dir /workspace/lib-release-0.5.0-candidate`

사용자 배포본 및 개발 소스본 후보 ZIP 생성 성공. 6종 플러그인 release 빌드와 런타임 검사, ZIP 내용·체크섬 검사, sourceUnchangedVerified 통과. 추출한 사용자 ZIP의 런타임 의존성 76 files / 159 local requires / 167 builtin requires 검증 성공, 소스 fallback 없음.

- 사용자 후보 SHA-256: `f2b5515e5f541c09284fcdbb9df43240cddc4d715e1186c7cf0dd103f6e32581`
- 소스 후보 SHA-256: `c2312884ef3ed1d1a4f22806a42b408b61e9ecad705a9baf8fa54fc9b3eb9ef8`

두 후보 모두 `publicationReady: false`, `updaterEligible: false`다. 정식 릴리즈 검사 실패를 우회한 배포본으로 사용하면 안 된다.

추가로 버전 입력 및 backend 버전 반영 범위 테스트 2개가 통과했다. GitHub 릴리즈·태그·원격 푸시는 수행하지 않았다.
