# GRADIA를 LIB 플러그인으로 통합하는 설계안

작성: 2026-10-07 12:27 UTC / 21:27 KST  
상태: 사용자 검토용 설계안. 제품 파일 이동·수정, 빌드, 테스트 실행은 아직 하지 않았습니다.

## 목표와 권장 구조

GRADIA를 LIB의 여섯 번째 플러그인으로 넣고, 소스·빌드·테스트·문서·패키징을 LIB 한 프로젝트에서 관리합니다. 설치되는 실행 파일은 `PROGRAM/plugins/GRADIA.js`입니다. 다른 플러그인처럼 같은 LIB 빌드 도구가 Full/Min을 만들며, 별도의 활성 GRA 프로젝트를 유지하지 않습니다.

**플러그인은 6개, 서버 저장 owner와 namespace는 기존 5개를 유지합니다.** GRADIA의 기존 읽기 전용 LIB 소비자 역할과 별도 reader principal을 보존합니다. GRADIA용 DATA 저장소, writer 권한, 자동 자격 증명 발급, LIBRA와의 SDK profile 합치기는 이 설계에 없습니다.

플러그인의 실제 식별자 `serial_gradation_agents_for_rp`와 현재 버전 `0.25.83`은 파일 이동만을 이유로 바꾸지 않습니다. 실제 서버 연결과 runtime facade binding은 별도 미완료 작업으로 남습니다.

## 어떤 파일을 어디로 옮기는가

아래의 GRA 경로는 조사한 `composed-r1/GRA/`를 기준으로 합니다. 목적지의 `PROGRAM/`은 새 LIB 프로젝트 내부 경로입니다.

| 현재 파일 | LIB 안의 목적지 | 용도 |
| --- | --- | --- |
| `src/GRADIA.js` | `PROGRAM/plugins/GRADIA.js` | 실제 설치·실행할 플러그인 원본 |
| `src/GradiaEvidenceBudget.source.js` | `PROGRAM/sdk/GradiaEvidenceBudget.source.js` | 현재 GRADIA에 포함된 예산 계산 helper의 원본 |
| `src/GradiaNativeProjection.source.js` | `PROGRAM/sdk/gradia/GradiaNativeProjection.source.js` | 개발·검증 중인 순수 모듈 원본 보존 |
| `src/GradiaReadV2Protocol.source.js` | `PROGRAM/sdk/gradia/GradiaReadV2Protocol.source.js` | 개발·검증 중인 순수 모듈 원본 보존 |
| `src/GradiaReadV2Credit.source.js` | `PROGRAM/sdk/gradia/GradiaReadV2Credit.source.js` | 개발·검증 중인 순수 모듈 원본 보존 |
| `src/GradiaReadV2Frames.source.js` | `PROGRAM/sdk/gradia/GradiaReadV2Frames.source.js` | 개발·검증 중인 순수 모듈 원본 보존 |
| `tests/` 전체 17개 파일 | `PROGRAM/tests/gradia/` | 현재 회귀 테스트, host, fixture 유지 |
| `verification/frozen-G2-GRADIA.js` | `PROGRAM/tests/gradia/fixtures/baselines/frozen-G2-GRADIA.js` | 현재 테스트가 직접 읽는 고정 기준 소스 |
| `tools/load-dev-dependency.cjs` | `PROGRAM/tools/gradia/load-dev-dependency.cjs` | 개발 의존성 로더. LIB 기준 경로로 조정 |
| `tools/load-dev-dependency.test.cjs` | `PROGRAM/tests/gradia/load-dev-dependency.test.cjs` | 로더의 경로 이식성 검증 |
| `docs/GRADIA-MIB-V2-SPEC.md` | `PROGRAM/docs/gradia/GRADIA-MIB-V2-SPEC.md` | 기존 프로토콜 설계 보존 |
| `docs/TOKEN-ACCOUNTING-PROFILE.md` | `PROGRAM/docs/gradia/TOKEN-ACCOUNTING-PROFILE.md` | 지원 profile과 제한 보존 |
| `docs/superpowers/plans/2026-10-07-gradia-g2-payload-budget.md` | `PROGRAM/docs/gradia/history/2026-10-07-gradia-g2-payload-budget.md` | 기존 설계 이력 보존 |

순수 모듈 4개는 현재 `GRADIA.js`에서 실행되는 모듈이 아닙니다. 이 통합에서는 새로 삽입하거나 활성화하지 않습니다. 현재 런타임에 포함된 별도 helper는 `GradiaEvidenceBudget.source.js`이며, 그 원본과 플러그인 내 포함 코드의 일치를 확인합니다.

### 반드시 함께 보존할 테스트 자료

현재 `tests/`에는 테스트 13개, `host.cjs` 1개, fixture 3개가 있습니다. fixture는 `gradia-projection-reference.cjs`, `gradia-budget-profile.cjs`, `gradia-builder-budget-host.cjs`입니다. 파일명과 테스트 의미를 유지하고 참조 경로만 변경합니다.

예산 테스트는 GRA 밖의 다음 파일도 직접 읽습니다. 외부 작업 폴더에 기대지 않도록 `PROGRAM/tests/gradia/fixtures/vendor/risuai/`에 고정 복사하고 출처·해시·LICENSE를 붙입니다.

- `src/ts/tokenizer.ts`: SHA-256 `ac4abc333a1497ed5260f3dfab52b3dc65c8a964b5dc38272e8d17125259b0cc`
- `src/etc/o200k_base.json`: SHA-256 `a2c363f80642c0f07d916716b3940ff030121f3b5cef72b2c5bd1d4f64c14fb8`
- `LICENSE`: 로컬 RisuAI 원본에서 확인한 GPL v3 문서. SHA-256 `919fa976e07af5d75768b3b45724854c42db3636ae5ccbd0d801a49690623835`
- 확인한 출처: `https://github.com/kwaroran/Risuai.git`, commit `f9728b14c733d073168d8d0c6a8f34f8febf0304`

이 두 소스 자료는 테스트 전용입니다. tokenizer 실행이나 새 런타임 의존성을 추가하지 않으며 사용자용 release payload에는 포함하지 않습니다. 출처와 license 기록은 배포 범위 점검에 함께 남깁니다.

기존 보존 회귀도 유지합니다. `verification/control-tail.test.cjs`, `gateway-tails.test.cjs`, `prompt-sinks.test.cjs`는 `PROGRAM/tests/gradia/preservation/`으로 옮기며 직접 읽는 다음 4개 기준 파일만 `fixtures/baselines/`의 같은 이름 하위 폴더에 보관합니다.

- `control-tail-checkpoint/GRADIA.before.js`
- `gateway-checkpoint/GRADIA.before.js`
- `gateway-checkpoint/GRADIA.before.min.js`
- `prune-checkpoint/GRADIA.before.js`

원래 핀에 묶인 `verification/actual-lib-contract.test.cjs`와 과거 scope/checkpoint 검증 스크립트는 역사 검증 자료입니다. 핀을 지우고 현재 통합 통과 증거로 바꾸지 않습니다. 현재 통합 검증에는 이미 LIB에 있는 SQLite→SDK→GRADIA 테스트를 사용합니다.

## 그대로 옮기지 않는 항목

- `dist/GRADIA.min.js`: 기존 검증 기준 산출물로 기록하고, 새 공식 산출물은 LIB 빌더가 다시 만듭니다. `PROGRAM/plugins/`에는 Full/Min 두 파일을 동시에 설치하지 않습니다.
- `build.cjs`: LIB 빌더에 흡수합니다. 예전 standalone 빌더를 두 번째 공식 빌더로 남기지 않습니다.
- `package.json`, `package-lock.json`: 이름만 바꿔 통째로 덮어쓰지 않습니다. 필요한 개발 의존성과 테스트 명령을 LIB 개발 도구 구성에 반영하고 기존 핀은 보존합니다.
- `backup/`, `restore-check/`, 다수의 `*-checkpoint/`, 로그, patch와 과거 검증 보고서: 기존 동결 기록을 보존하고 새 프로젝트 문서에서 출처를 안내합니다. 위에서 특정한 현재 테스트용 기준 파일만 옮깁니다.
- `node_modules`, Node 실행 파일, npm cache, 실제 DATA, 자격 증명과 사용자 저장 데이터: 플러그인 통합 대상이 아닙니다.

현재 확인한 도구 체인은 acorn `8.15.0`, terser `5.51.2`, jsdom `26.1.0`입니다. GRA의 acorn·terser 핀과 일치하므로 의존성 업그레이드는 필요하지 않습니다. 설치나 도구 체인 변경은 수행하지 않았습니다.

## 파일 이동 외에 필요한 LIB 변경

GRADIA 파일만 추가하면 현재 배포기가 실패합니다. `build_distribution.cjs`는 플러그인 개수를 정확히 5개로 제한하고 GRADIA 식별자를 허용하지 않습니다. 다음 항목만 여섯 번째 **배포 플러그인**을 인식하도록 조정합니다.

1. `PROGRAM/tools/build_plugins.cjs`: `gradia` 등록과 Full/Min 생성. 기존 다섯 플러그인의 변환 결과를 보존합니다. 현재 LIB 빌더는 header 보존·개발용 test surface 제거·minify·문자열 키 변환을 수행하므로 GRADIA의 기존 단순 minify와 같다고 가정하지 않고 공개 동작 동등성을 검증합니다.
2. `PROGRAM/tools/build_distribution.cjs`: 허용 플러그인 ID, 고정 개수, 파일 목록과 declaration binding에 GRADIA 반영. 가능하면 공통 배포 registry에서 목록을 가져와 중복 목록 간 불일치를 막습니다.
3. `PROGRAM/tools/release_metadata.cjs`, `update_manifest.cjs`, `UPDATER/release_archive.cjs`: 파일·이름·버전·해시를 플러그인 목록에 반영. `PROGRAM/program-manifest.json`, `update-manifest.json`, checksum은 검증된 로컬 후보에서 도구로 다시 생성합니다.
4. `0_설치_안내.txt`, `PROGRAM/처음_읽어주세요.txt`, `PROGRAM/PACKAGE_CONTENTS.txt` 및 최상위 안내: GRADIA 설치 위치와 여섯 플러그인 목록 반영.
5. `PROGRAM/tests/program_data_layout_test.cjs`, `test_surface_strip_test.cjs` 및 배포·manifest·runtime 테스트: 배포 플러그인 목록은 여섯 개로 검증합니다. `gradia_free_contract_test.cjs`의 “GRADIA 파일을 배포하지 않음” 두 assertion만 새 의도에 맞게 교체하고, 다섯 owner·고아 DB 비변경·reader 전용 권한 assertion은 유지합니다.
6. GRA 테스트의 `../src`, `../dist`, dependency loader, 고정 fixture 참조를 새 경로로 변경합니다. LIB의 `gradia_readonly_cross_project_test.cjs`, `composed_reanalysis_gradia_runtime_test.cjs`, `review_readonly_worst_escape_test.cjs`의 `../../../GRA/tests/host.cjs`도 내부 경로로 바꿉니다.

GRADIA의 기존 테스트 일부는 파일명에 `.min.`이 있는지로 source-only skip을 판단합니다. LIB의 `build/Min/GRADIA.js`에서는 이 조건이 성립하지 않으므로 명시적인 빌드 flavor를 전달하도록 테스트 경로 계약을 정리합니다. 기존 skip을 숨기거나 전부 통과한 것으로 합산하지 않습니다.

`sync_embedded_sdk.cjs`와 `check_sdk_sync.cjs`의 기존 다섯 writer/profile 목록에 GRADIA를 무조건 추가하지 않습니다. GRADIA에는 이 다섯 플러그인과 같은 내장 Storage SDK block이 없습니다. 공통 reader SDK와 LIBRA 전용 SDK를 그대로 보존하며, 플러그인 목록 통합을 이유로 저장 권한이나 runtime binding을 변경하지 않습니다.

현재 GRADIA의 `//@update-url`은 별도 GRADIA 저장소를 가리킵니다. 파일 이동 시 검증하지 않은 LIB 배포 URL을 만들어 넣지 않습니다. 로컬 후보에는 기존 값을 명시적으로 기록하고, 실제 배포·자동 업데이트 전에는 사용자가 선택한 정식 배포 경로와 맞아야 합니다. 이번 설계는 업로드·공개·main 병합을 포함하지 않습니다.

## 적용 기준과 검증 순서

1. **기준 확정:** 현재 `composed-r1`은 GRA reader와 LIBRA 재분석이 함께 있는 동결 기반이며 한정 오프라인 작성자 검증 상태입니다. 최신 LIB 공통 정책 r2는 별도 독립 실행 검토가 막혀 있습니다. 폴더 통합을 이용해 r2를 승인된 것으로 간주하거나 검토를 우회하지 않습니다.
2. **한 작업본 준비:** 설계 승인 후 원본을 보존한 새 LIB 작업본 하나에서 위 경로 통합을 진행합니다. 각 파일의 이전 경로·새 경로·해시를 기록해 누락과 예기치 않은 내용 변경을 검출합니다. 외부 폴더 symlink로 완결성을 가장하지 않습니다.
3. **목록과 경로 정리:** 빌드·패키지·문서·테스트 경로만 수정합니다. 먼저 이전 다섯 플러그인의 소스, Storage SDK, 서버 코드는 바이트 동일함을 확인합니다. 예산 helper 원본과 기존 포함 코드도 확인합니다.
4. **빌드 검증:** source/Full/Min 모두 GRADIA ID·version·공개 API·필수 directives를 보존해야 합니다. 다섯 기존 플러그인의 같은 입력에 대한 빌드 결과도 비교합니다. 실패를 숨기거나 옛 Min 파일을 새 빌드 결과로 대체하지 않습니다.
5. **회귀와 패키징 검증:** 아래 행렬을 실행할 수 있는 승인된 환경에서 수행합니다. 독립 실행 검토의 기존 차단이 해당 실행에도 적용되면 그 단계는 중단하고 정확한 차단으로 남깁니다. 현재 이 설계 작성 중에는 제품 테스트를 실행하지 않았습니다.
6. **최신 r2 반영:** r2의 검토 조건이 충족된 뒤 누적 `SOURCE-DELTA.patch` 방식으로 반영합니다. 플러그인 통째 덮어쓰기는 하지 않습니다. adapter 소유 Storage SDK와 LIBRA 전용 SDK 보존을 확인하고 새 조합 전체를 재검증합니다.

| 검증 범위 | 확인할 결과 |
| --- | --- |
| 파일 매핑·fixture·license·경로 | 필요한 소스와 fixture 누락 없음, 원본 해시 유지, 활성 외부 GRA 경로 의존 없음 |
| GRADIA source/Full/Min | 공개 reader/dispatch와 native 동작, 예산 경계, 기존 source-only 제한 유지 |
| 기존 다섯 LIB 플러그인 | 소스·SDK profile 유지, 기존 영향 회귀와 빌드 결과 보존 |
| SQLite → 서버 → SDK → GRADIA | 읽기 시 데이터·operation 비변경, 정식 기억 교체 시 이전 draft 무효화, 큰 항목 제외 후 currentness 유지 |
| 설정과 명시적 재분석 | 기존 source/Full/Min producer·settings DOM 조합 재검증 |
| 배포·manifest·updater | 플러그인 6개, 한 plugin 폴더, owner/namespace 5개, 올바른 버전·해시, DATA 비변경 |
| 이력 보존 | 원본 checkpoint와 백업 불변, 역사적 검증 결과와 새 결과 구분 |

이 작업의 완료 기준은 **LIB 한 프로젝트에서 여섯 플러그인의 개발·빌드·패키징·테스트 경로가 일관되게 작동하는 것**입니다. 실제 RisuAI/Windows/공급자 환경, 새 서버 연결, 성능·용량, 전체 LIB 저장소 수명주기 완료를 뜻하지 않습니다. WM은 변경하지 않습니다.

## 조사에 사용한 기준

- 중간 조합: `/workspace/shared/lib-gra-composed-20261007T0855Z/checkpoints/composed-r1`
- 조합 checkpoint SHA-256: `87d11c1b4fdbb9ea20f395dbed925691a2b148120b654a97aaa00f9de8b74a82`
- 최신 미통합 LIB r2: `/workspace/shared/lib-shared-reanalysis-r2-20261007T1051Z/checkpoints/r2`
- r2 checkpoint SHA-256: `e2a68464ca2f45be08ebb56fca3ab8d9dc5ced5a54a924ea5b982352529d8403`
- 현재 상태: [전체 작업 현황](PROJECT-WORK-STATUS-20261007.md)

이번 산출물은 이 설계 문서뿐입니다. 프로젝트 통합, Git 초기화·원격 연결, 제품 테스트 실행 또는 배포가 완료됐다는 기록이 아닙니다.
