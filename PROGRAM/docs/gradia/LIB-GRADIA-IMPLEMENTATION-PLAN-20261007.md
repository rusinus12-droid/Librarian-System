# LIB 안에서 GRADIA를 빌드하는 실행 계획

작성: 2026-10-07 12:43 UTC  
설계: [GRADIA 플러그인 통합 설계안](LIB-GRADIA-PLUGIN-INTEGRATION-20261007.md)  
상태: 설계 승인 후 실행 준비. WM 측정 종료 확인 전에는 작은 문서 작성과 읽기만 수행합니다.

## 기준과 결과 위치

- 주 작업 경로: `/workspace/scratch/d09f18a13aaa/projects/LIB`
- 기반: `/workspace/shared/lib-gra-composed-20261007T0855Z/checkpoints/composed-r1/LIB`
- GRADIA 입력: 같은 checkpoint의 `GRA/`. 플러그인 코드의 시작 내용은 바이트 동일하게 가져옵니다.
- 최신 LIB 공통 정책 r2는 제품에 적용하지 않습니다. 누적 patch·핀·검토 상태·재현 안내를 `PROGRAM/docs/gradia/pending-lib-r2/`에 보존합니다. 현재 작업 기반에 이전 공통 정책이 있다는 사실을 첫 안내에 명시합니다.
- 개발 빌드와 실행 증거는 `.development/` 안에서 관리하되 배포 package에는 복사하지 않습니다. 설치용 `PROGRAM/plugins/`는 하나이며 그 안에는 여섯 원본 파일만 있습니다.
- Git 초기화·remote 연결·push·main 병합, 실제 DATA 활성화, 새 계정·권한·자격 증명, 외부 모델 호출, dependency 설치는 하지 않습니다.

## 1 안전한 작업본과 기준 기록

WM 측정 종료 확인 후 실행합니다. 새 경로가 비어 있음을 확인하고 동결 기반을 새 파일로 복사합니다. 원본과 checkpoint는 수정하지 않습니다. `DATA/`는 빈 배포 template인지 확인하고, 실제 database·token·사용자 데이터가 발견되면 복사하지 않고 보고합니다.

새 작업본에 파일 매핑, SHA-256, 제외 항목, 기반 checkpoint pin을 기록합니다. GRADIA의 six source files, 현재 테스트 17개, preservation 테스트 3개와 직접 참조하는 baseline, pinned RisuAI fixture 2개와 LICENSE를 설계안 경로로 배치합니다. `node_modules`와 외부 경로 symlink는 만들지 않습니다.

## 2 배포 목록의 실패하는 테스트부터 추가

새 `PROGRAM/tests/gradia_plugin_integration_test.cjs`를 먼저 작성하고 현재 도구에서 실패하는 이유를 확인합니다.

- 플러그인 registry와 metadata에는 정확히 6개가 있어야 합니다.
- GRADIA ID는 `serial_gradation_agents_for_rp`여야 합니다.
- `build_plugins --plugin gradia`가 실제 source/Full/Min 파일을 만들 수 있어야 합니다.
- manifest/update component 목록은 GRADIA 버전·파일 해시를 포함해야 합니다.
- 서버 owner/namespace는 기존 5개이고 GRADIA에 writer가 생기면 실패해야 합니다.
- 활성 테스트/빌드 경로가 옛 `GRA/` 작업 폴더를 참조하면 실패해야 합니다.

계획한 새 assertion이 현재 구현에서 실패하는 것을 확인한 뒤 구현합니다. 네트워크와 listening socket을 막는 기존 preload를 유지합니다. 실행 거절이 나오면 우회하거나 다른 엔진에서 재시도하지 않고 정확히 보고합니다.

## 3 최소 빌드와 패키징 변경

`build_plugins.cjs`, `release_metadata.cjs`, `build_distribution.cjs`, `update_manifest.cjs`, `release_asset_contract.cjs`, `UPDATER/release_archive.cjs`의 배포 plugin 목록을 일치시킵니다. source-workspace 전용 `.development/`와 첫 안내를 package 복사 대상과 엄격히 구분합니다.

`program_data_layout_test.cjs`, `test_surface_strip_test.cjs`, `gradia_free_contract_test.cjs`와 관련 패키징 fixture의 배포 개수 기대값을 새 의도에 맞게 바꿉니다. five-owner·고아 데이터 보존·읽기 전용 권한 조건은 변경하지 않습니다. 기존 SDK sync에 GRADIA writer를 추가하지 않습니다.

## 4 테스트 경로와 문서 통합

`PROGRAM/tests/gradia/` 안의 원본·SDK·의존성 loader·baseline 참조, LIB의 cross-project host 참조를 내부 경로로 변경합니다. Min 여부는 명시적인 빌드 flavor로 전달하여 `.min.` 이름 검사에 의존하지 않게 합니다. 기존 source-only skip은 명시적으로 유지합니다.

새 첫 안내와 기존 설치 안내, package inventory에 실제 경로를 기록합니다. GRADIA update-url은 기존 값을 유지하고 정식 LIB 배포 주소 확정 전 release 미승인 상태임을 표시합니다. 이전 `GRA/build.cjs`와 옛 Min을 새 빌드 결과로 사용하지 않습니다.

## 5 검증과 증거

한 프로세스 계열씩 직렬 실행하고 명령, 종료 코드, pass/fail/skip, source/build 해시를 `.development/evidence/`에 기록합니다. Node `v24.19.0`, acorn `8.15.0`, terser `5.51.2`, jsdom `26.1.0` 기존 도구 체인을 재사용합니다.

1. 새 registry/layout/metadata 테스트의 RED→GREEN 확인
2. GRADIA 기존 source 전체, preservation, loader 테스트
3. 여섯 플러그인 Full/Min 빌드와 syntax/directive/API 확인
4. GRADIA Full/Min public reader/dispatch, native 동작; source-only skip 별도 기록
5. 기존 SDK/profile, LIBRA 영향 범위, adapter LIB/auth/legacy, SQLite→SDK→GRADIA 및 32 MiB 경계
6. source/Full/Min producer 재분석과 설정 DOM 조합
7. manifest/update component/checksum 재생성 후 file set·해시·6 plugin/5 owner 검증
8. 허용된 환경에서 local source/release packaging 검증. 기존 aggregate나 socket-dependent 검증이 차단되거나 실패하면 이름과 원인을 보고하고 전체 통과를 주장하지 않습니다.

마지막으로 원본의 해시, 새 프로젝트의 외부 소스 의존 여부, source→Full/Min 매핑을 검증합니다. 정리 문서에는 완료·실패·차단·미실행을 구분합니다. 기존 LIB r2 검토는 재실행하지 않습니다.

## 완료 보고

`FIRST-README.md`와 `docs/PROJECT-WORK-STATUS-20261007.md`는 실제 완료 범위에 맞춰 갱신합니다. 아직 남은 r2 반영, 실제 연결·host·Windows·성능 검증과 배포 URL 결정을 분명히 남깁니다. 이번 통합의 완료를 전체 LIB 제품 완료로 확대하지 않습니다.
