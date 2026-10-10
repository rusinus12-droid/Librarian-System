# 2026-10-10 개발 재개 안내

## 서로 다른 실제 시각
- 원시 검증 증거 마감: 2026-10-10 09:00:05.893301 UTC
- 개발 소스 포착: 2026-10-10 09:01:31.558490~09:01:32.351760 UTC
- 소스 기준: clean commit 2f6c49e69768232f8284163ef25252b987032e83

두 시각을 같은 포착 시각으로 간주하지 않습니다. 증거 마감 이후 실행 결과를 모두 포함한 것으로 해석하면 안 됩니다. 소스 포착 전후 1,904개 원본 파일의 경로·bytes·SHA-256·mode가 같았고, 아래 연결 정보를 작성할 때도 원본 inventory와 일치했습니다. 원본 tree SHA-256은848401e65404f20e2231a4b2219b6d8459856e2f770361221d1f18aabaffc379입니다. 각 파일 근거는 ACTIVE-SOURCE-MANIFEST.json에 있습니다.

## 개발 소스 재개
이 source ZIP만으로 당시 전체 개발 소스와 고정 fixture를 복구할 수 있습니다. 이전 증분 ZIP은 필요하지 않습니다. RESTORE.md의 Python 명령은 새로운 별도 폴더에 원본 경로·바이트·권한을 복원합니다. 원래 builder 추출본은 그대로 보관하세요. 원본 Git object history와 설치된 의존성·모델·사용자 DATA는 포함하지 않습니다. 기존 locked build-support 파일에 명시된 개발 의존성을 별도로 준비해야 하며, 복원 자체는 설치나 제품 실행을 하지 않습니다.

별도 test-successors/001·002는 검증됐지만 활성 소스에 미적용입니다. 003의 두 시험은 준비만 되었고 실행하지 않았습니다. wrapper3개 퇴역 후보도 원본에서 삭제하지 않았습니다. REGRESSION-STATUS.json의 미통과·차단·미실행 분류를 유지하고 원형 결과를 보존한 뒤 유지할 실패를 정정하세요. 전체 회귀 완료나 새 release/updater 적격성을 주장하는 패키지가 아닙니다.

## 같은 checkpoint의 private raw 증거
파일: Librarian-System-Regression-Evidence-20261010T090005Z.zip
크기: 59,088,899 bytes
SHA-256: f290cf3e212273265d8634bc0626eaee17ea12ea02726618bec46b321f0221a2
마감: 2026-10-10 09:00:05.893301 UTC

이 sidecar는 선택된 원시 로그·guard·영수증·원본 정정 백업의 objects/pathmap 복원을 위한 것입니다. 개발 소스 재개에는 필요하지 않으며 public GitHub에 올리지 않습니다. 후속 결과는 이 고정 checkpoint에 자동 반영되지 않습니다. 이후 만들어진 heavy-cohort 제어 스크립트와 결과는 이번 마감의 증거가 아닙니다. 정확한 두 파일 연결은 CHECKPOINT-PAIR.json을 확인하세요.

source ZIP 자신의 SHA-256·크기와 실제 builder/복원 검증은 ZIP 밖의 최종 영수증에서 제공합니다. ZIP 안에 자신의 해시를 넣거나 원본 ZIP을 다시 압축하지 않습니다.
