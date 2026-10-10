# Librarian System 0.3.51 안전 이관

## 목적

기존 업데이트 방식인 `새 PROGRAM + 기존 DATA 그대로 사용` 대신, 구버전 서버의 **논리 데이터**를 이관 ZIP으로 내보내고 신버전의 **새 빈 DATA**가 현재 스키마로 다시 기록하도록 합니다.

이관 ZIP은 구 SQLite/WAL/SHM을 목적지의 운영 DB로 그대로 붙이지 않습니다.

## 최초 이관 — 0.3.50 이하에서 0.3.51로

1. 기존 Librarian Backend를 정상 종료합니다.
2. 기존 DATA 폴더는 삭제하거나 새 설치 DATA에 덮어쓰지 말고 보존합니다.
3. 0.3.51을 별도 폴더에 압축 해제합니다.
4. 다음 읽기 전용 도구로 **중지된 구 DATA**에서 이관 ZIP을 만듭니다.

Windows:

```text
PROGRAM/기존_DATA_이관_ZIP_만들기.bat
```

macOS / Linux:

```text
PROGRAM/기존_DATA_이관_ZIP_만들기.sh
```

직접 실행:

```text
node PROGRAM/tools/portable_export_stopped.cjs --source-data-dir "<구 DATA>" --output "<이관 ZIP>"
```

5. 0.3.51의 **새 빈 DATA**로 서버를 실행합니다.
6. 최신 다섯 플러그인을 설치/갱신합니다.
7. RE:TRACE → 서버 데이터 → 백업·복원에서 이관 ZIP을 선택합니다.
8. `업로드·검사` 후 미리보기를 확인합니다. 검사만으로는 운영 DB를 바꾸지 않습니다.
9. 복원을 승인합니다. 기존 자료가 있는 서버에서는 대체 경고가 먼저 표시됩니다.
10. 완료 후 서버를 재시작하고, 각 owner에서 서버 자료 사용을 확인한 뒤 RisuAI를 새로고침합니다.

## 0.3.51 이후

RE:TRACE의 기본 내보내기 형식인 **안전 이관 ZIP (논리 데이터 / 새 DB)** 을 사용합니다.

## 이관되는 것

- flashback / hayaku / libra / lia / retrace 서버 namespace의 논리 KV 레코드
- 삭제 표식(tombstone)과 revision/digest
- scope catalog
- 이관에 허용된 서버 설정의 논리 값
- 과거 operation 기록은 이력 자료로 보관하되, 목적지의 활성 idempotency receipt로 재사용하지 않음
- HAYAKU Recovery Vault 등 정상적인 미해결 지속 상태는 보존하되 과거 lease/자동 승인권은 재사용하지 않음

## 이관되지 않는 것

- RisuAI 원본 채팅 / Persona DB
- 서버에 저장된 적 없는 `plugin_only` 기억
- API key와 Provider credential
- runtime token / compute signing key / PID / lock / upload session / 일시 staging
- 브라우저 전역 Source Rules 같은 서버 밖 설정

## 안전 원칙

- 필수 정본 참조나 벡터 참조가 손상되어 있으면 조용히 누락하고 성공 처리하지 않습니다.
- LIBRA의 미완료 unified prepared transaction처럼 정본을 확정할 수 없는 상태는 이관을 차단하고 먼저 복구를 요구합니다.
- 목적지 DB는 현재 서버의 schema로 새로 생성합니다.
- 복원 실패 시 기존 목적지 자료와 지원되는 설정을 rollback합니다.
- 성공 확인 전까지 구 DATA와 이관 ZIP을 모두 보존하십시오.

## 기존 DB 스냅샷

RE:TRACE의 `기존 DB 스냅샷 ZIP (호환용)`은 호환·재해복구 도구로 유지됩니다. 안전한 버전 이관의 기본 권장 경로는 **논리 이관 ZIP**입니다.
