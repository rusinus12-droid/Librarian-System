# Librarian System Release Builder

Release Builder는 하나의 공통 엔진에서 두 종류의 패키지를 만든다.

## 1. 사용자 배포본 — updater가 인식하는 공식 자산

- 파일명: `Librarian-System-X.Y.Z.zip`
- 프로필: `release`
- GitHub Release의 공식 updater asset이다.
- `PROGRAM/tests`, 개발 이력 문서, 회귀 runner, Release Builder 자체와 개발 전용 도구는 포함하지 않는다.
- 서버 런타임, 7개 RisuAI 플러그인 JS, 필요한 SDK/도구, 관리도구, clean DATA, UPDATER만 runtime allowlist로 포함한다.
- `update-manifest.json`의 `assetName`은 항상 이 파일을 가리킨다.

실행:

```sh
node tools/build_distribution.cjs --profile release
```

Windows에서는 `배포본_만들기.bat`, POSIX에서는 `배포본_만들기.sh`를 사용한다.

## 2. 개발 소스본 — updater 대상 아님

- 파일명: `Librarian-System-X.Y.Z-Source.zip`
- 프로필: `source`
- tests/docs/개발 도구를 포함한 개발자용 전체 소스다.
- clean DATA만 포함하며 사용자 DB, 인증 토큰, 로그는 포함하지 않는다.
- 예외는 소스 검증에 필요한 합성 golden fixture 5개(SQLite 및 sidecar)뿐이다. 정확한 경로·크기·SHA-256을 원본 검사, staging 직후, ZIP 직전에 확인하며 임의 DB는 허용하지 않는다.
- 현재 WM 계약·inventory 문서 13개를 명시적 source allowlist로 포함한다. 이 fixture와 문서는 runtime 배포본에 포함하지 않는다.
- `offline_candidate` 소스 패키지는 오프라인 검증용 스냅샷이다. 전체 release gate 또는 실제 RisuAI·Windows 검증 완료를 뜻하지 않는다.
- 파일명과 ZIP root 모두 `-Source`가 붙으므로 updater의 공식 asset parser가 거부한다.

실행:

```sh
node tools/build_distribution.cjs --profile source
```

Windows에서는 `개발본_만들기.bat`, POSIX에서는 `개발본_만들기.sh`를 사용한다.

## 3. 둘 다 한 번에 만들기

```sh
node tools/build_distribution.cjs --profile all --version X.Y.Z
```

또는 `전체_릴리즈_만들기.bat/.sh`를 사용한다. 버전 승격은 한 번만 적용되고 같은 버전의 Release/Source 두 ZIP이 생성된다. 둘 중 하나가 실패하면 성공한 쪽의 산출물도 제거하고 버전 승격 전 소스로 되돌린다.

## 버전 입력

- `배포본_만들기`: 현재 버전보다 높은 `x.y.z`를 입력해 정식 버전을 승격한다.
- `개발본_만들기`: Enter를 누르면 현재 버전의 소스 스냅샷을 만든다. 더 높은 버전을 명시하면 승격할 수도 있다.
- `전체_릴리즈_만들기`: 다음 patch 버전을 기본 제안하고 Release/Source를 같은 버전으로 만든다.

## 검증 순서

1. 원본 소스에서 필수 release smoke를 실행하고 소스 해시 불변을 확인한다.
2. profile별 staging을 만든다.
3. 사용자 Release는 runtime allowlist만 복사한다. Source는 전체 safe source allowlist를 복사한다.
4. 두 profile 모두 clean DATA를 새로 생성한다.
5. staged PROGRAM manifest와 root SHA256SUMS를 staging 내용에 맞춰 다시 생성한다.
6. ZIP 생성 후 directory/ZIP readback과 private DATA 부재를 검증한다.
7. Release build report에는 `updaterEligible: true`, Source에는 `false`를 기록한다.

GitHub updater가 찾는 자산은 **오직 `Librarian-System-X.Y.Z.zip`** 이다. `-Source.zip`은 개발자 보관용이며 이름을 바꿔 공식 asset으로 사용하지 않는다.
