# LIB·GRADIA 기능 통합 결과

기준: 2026-10-07 14:55 UTC / 23:55 KST. 승인된 기능 구현과 작성자 기본 검사 결과입니다. 정식 출시·전체 안정화 승인은 아닙니다.

## 구현

- 단일 `LIB/PROGRAM/plugins/`에서 여섯 플러그인을 관리하고 같은 Full/Min·manifest·package 도구에 GRADIA를 등록했습니다. 별도 활성 GRA 폴더나 외부 GRA 소스 경로가 필요하지 않습니다.
- 활성 서버 저장 writer는 Flashback·HAYAKU·LIBRA 세 개입니다. LIA는 local_only와 명시적 legacy_reader, RETRACE는 manager_only이며 일반 서버 쓰기는 없습니다. 다섯 legacy namespace는 호환·백업 슬롯으로 보존합니다. GRADIA는 기존 LIBRA 읽기 전용 consumer입니다.
- GRADIA의 기존 설정 내보내기·가져오기에서 runtime/provider metadata/agent slots/custom prompts를 보존하고 비밀값 내보내기 선택을 제거했습니다. 자격 증명 필드·인증 header·URL 인증 정보를 제외합니다. 프리셋 이름과 사용자 프롬프트 본문은 민감 필드명과 구분합니다.
- 가져오기는 전체 구조를 검증한 뒤 GUI 초안에 반영하고 기존 저장 버튼 한 번으로 적용합니다. 실패 시 정확한 기존 값을 조건부 복원하며 외부 변경 또는 복원 실패는 미확인 상태로 알립니다. 임의 외부 raw writer에 대한 원자적 CAS 보장은 아닙니다.
- 구형 Writer·Story Arc·Narrative Archive·session-transfer 구현 320개 선언과 공개 API 37개를 제거했습니다. RETRACE 등록과 자동 native-copy 채택 경로도 제거했습니다. 활성 창작 지침 OOC는 선택한 단계의 전역 promptOverrides를 생성·저장하고 실제 실행에 사용합니다.
- 구형 사용자 저장 바이트는 지우지 않습니다. 이전 manual instruction의 한정 읽기·현재 전역 지침 복구는 남기며 새 인계·작업·evidence handle을 전송하지 않습니다.

## 확인한 범위

- 최종 source와 Full: 설정 백업 GUI·활성 OOC·퇴역 데이터 보존 11/11
- 최종 Min: 같은 범위 10 통과, source-only 내부 reset 계측 1 skip
- 최종 Full/Min: 각각 여섯 플러그인 생성·구문·directive·공개 API 로드
- 현재 변경 전 reader/native/draft 기본 검사: 29/29 및 42/42. 이후 변경은 설정 JSON 필드/프리셋 이름 구분뿐이며 이 71개를 최신 해시 전체 재실행으로 표시하지 않습니다.
- 현재 등록 5건과 package/layout/manifest 6건의 최종 결과는 `.development/STATUS.json`을 확인합니다.

Min 첫 최종 실행에서 source-only reset 계측용 flavor 환경변수를 빠뜨려 1건이 실패했습니다. 제품 실패가 아닌 내부 계측 불가 오류를 기록하고, 명시적 Min 조건으로 재실행한 결과가 위 10+1 skip입니다. RED·중간 실패 로그는 `.development/evidence/`에 보존합니다.

## 재현과 파일

`PROGRAM/tests/gradia/settings-backup.test.cjs`, `legacy-removal.test.cjs`, `memory-retirement.test.cjs`는 실제 GUI 또는 공개 API를 실행합니다. 기본 통합·패키지 계약은 상위 `PROGRAM/tests/`에 있습니다. `GRADIA_FILE`로 산출물을 지정하고 Min에서는 `GRADIA_BUILD_FLAVOR=Min`을 함께 지정합니다.

필수 helper·fixture·RisuAI 고정 소스 두 개·GPL 라이선스와 provenance는 모두 이 프로젝트 안에 있습니다. 고정 Node/npm 개발 도구는 `.development/run-node.sh`의 `LIBRA_TOOLCHAIN` 경로를 사용합니다. 설치한 node_modules·사용자 DATA·자격 증명은 제품 소스에 포함하지 않습니다.

## 남은 범위

최신 공통 입력 정책 r2는 미적용·독립 실행 검토 차단 상태입니다. `composed-r1` 위에 이번 승인된 LIA/RETRACE 역할 delta와 GRADIA 기능만 합쳤습니다. 실제 reader binding·RisuAI·Windows·공급자·성능·전체 release gate·배포 ZIP·통합 update URL은 남아 있습니다. 기존 gate나 보안 guard는 끄지 않았습니다. 원본·기존 checkpoint는 보존했습니다.

사용자 중단 시각: 2026-10-07 17:00 UTC / 2026-10-08 02:00 KST. 그때까지 안전한 체크포인트와 보고를 마치고 새 명시적 요청 전 개발을 재개하지 않습니다.
