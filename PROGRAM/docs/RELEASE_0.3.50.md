# Librarian System 0.3.50

## 이번 변경

- RE:TRACE → 서버 데이터 → 백업·복원에 **서버 전체 기억 ZIP 저장**, **ZIP 선택 → 업로드·검사 → 확인 후 전체 복원**을 추가했습니다. 빈 서버와 기존 서버 모두 사용할 수 있습니다.
- 전송은 256 KiB 단위이며, 압축·압축 해제·파일 SHA 검사는 Worker에서 스트리밍 처리합니다. 청크 및 전체 파일 SHA-256을 검증합니다. 업로드·검사만으로 운영 기억을 대체하지 않습니다.
- 기존 데이터가 있으면 지정된 경고문을 표시합니다. 확인 후 데이터가 바뀌면 복원 계획을 거부합니다. 기존 백업·복원 저널·되읽기·세대 차단을 재사용합니다.
- LIBRA 설정의 기억과 검색에 **현재 서버 scope 건강 검사**와 **진단 복사**를 추가했습니다. 서버 단독·미러에서 현재 LIBRA scope의 manifest 참조, prepared state/vector/replay 작업, Head/Registry 연결 등을 제한된 읽기 전용 검사로 확인합니다. 자동 수정·초기화·모델 호출은 하지 않습니다.
- RE:TRACE namespace 조사에서 `pluginListing` / `localListing` 참조가 누락되어 예외가 나는 실제 코드 결함을 수정했습니다.
- 좁은 화면에서 원문 비교창 footer 버튼을 두 열로 정리했습니다. 승인·근거·취소의 기존 의미는 유지했습니다.

## 버전

Backend/배포 0.3.50, LIBRA 2.3.121, HAYAKU 3.0.129, Flashback 1.0.91, LIA 0.26.77, RE:TRACE 1.9.79, Storage SDK 1.8.21. Compute SDK 0.3.6, Storage Protocol 1.9, Compute Protocol 1.2, DATA layout 1은 유지합니다.

## ZIP의 정확한 범위

**다섯 namespace의 서버 DB와 scope catalog를 포함하는 전체 서버 기억 snapshot**입니다. DATA 디렉터리의 모든 파일을 복사하는 형식이 아닙니다. RisuAI 원본 채팅·Persona DB, 브라우저에만 있는 plugin_only 자료, API key, runtime token, 전역 Source Rules, 이전 백업 세대·로그·서버 설정은 포함하지 않습니다. 새 서버의 인증 신원과 PROGRAM은 유지됩니다.

완료 상태는 서버 자료 복원 완료입니다. 각 플러그인이 복원된 서버 자료를 다시 확인하고, RisuAI 원문과 Source Rules를 검토하는 작업까지 자동 완료로 표시하지 않습니다. UI 안내에 따라 owner에서 서버 자료 사용을 선택한 뒤 RisuAI를 새로고침합니다. 이전 로컬 자료를 재업로드하면 복원 의도와 달라질 수 있습니다.

## 크기와 호스트 제한

새 전송은 ZIP32 최대 2 GiB, 해제 후 총 4 GiB, entry 최대 2 GiB, 파일 수 4096개 제한입니다. ZIP64, 암호화 ZIP, 일반 목적 ZIP은 받지 않습니다. File System Access 또는 OPFS로 스트리밍 저장할 수 없는 환경에서는 **다운로드만 64 MiB로 제한**하며 조용히 큰 Blob을 만들지 않습니다. 실제 브라우저 기능과 허용 권한에 따라 경로가 달라집니다.

기존 서버 로컬 archivePath 도구는 보존되며, 그 기존 API의 버퍼링·상한은 새 전송과 다릅니다. ZIP64나 제한 최대치 전 구간의 실제 메모리 사용량을 검증했다는 뜻은 아닙니다.

## 업데이트

최초에는 서버를 종료하고 기존 DATA 전체를 별도 복사한 뒤 PROGRAM과 다섯 플러그인을 함께 교체하세요. 새 배포 ZIP의 빈 DATA로 기존 DATA를 덮어쓰지 마세요. 신기능이 설치된 뒤부터 RE:TRACE ZIP 이동 경로도 사용할 수 있습니다. 기억 전체 삭제·재분석·일괄 재임베딩은 필요하지 않습니다.

## 검증 경계

배포와 별도로 제공하는 감사 보고서의 실제 실행 결과를 기준으로 합니다. 합성 RisuAI API를 사용하는 전체 owner 브라우저 시험과 실제 임시 HTTP/SQLite 시험은 실제 RisuAI 설치·외부 모델·Docker 네트워크·다른 OS 검증과 구별합니다.
