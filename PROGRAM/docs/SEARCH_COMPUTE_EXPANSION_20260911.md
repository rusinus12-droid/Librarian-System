# 기억 검색 컴퓨트 연산 확대

2026-09-11 로컬 수정본. 표시 버전은 유지하며 manifest와 실제 소스 해시로 식별한다.

## 구현

- Flashback: 기존 해시 임베딩 생성 외에 저장된 벡터와 질의·문맥·이전 턴 벡터의 cosine 계산을 서버 워커로 보낸다. 외부 모델 임베딩도 포함한다. provider/model/profile 호환성, 검색 후보 정렬, 증거 선택 규칙은 기존 엔진이 적용한다.
- LIBRA: BM25F 서버 연산을 유지하고, 기억 적재 후 global/section 벡터의 질의·장면 cosine 계산을 배치로 서버에 보낸다. 섹션 가중치와 dense 점수, 최종 증거 선택은 기존 계약을 유지한다. 최초 catalog 후보 선택은 로컬이다.
- HAYAKU: 현재 활성 localRecallCandidates 경로의 직접 질의와 최근 문맥 검색을 연결한다. 서버가 원문 토큰화, 문서 빈도, BM25 관련도 및 후보 순위를 계산한다. RRF만 호출하는 변경이 아니다. 검색 가능 여부·비공개 정보 필터는 보내기 전에 적용하고, 선언된 연결 확장 및 최종 선택은 로컬에서 유지한다.

새 연산은 flashback.memory-search.v1, libra.memory-search.v1, hayaku.memory-search.v1이다. 공통 순수 커널 소스의 SHA256을 fingerprint로 사용하고 같은 코드를 플러그인에 내장한다.

## 검색 자료 재사용

처음에는 플러그인이 현재 저장 경로에서 읽고 승인한 검색 자료를 전달한다. 서버가 corpus SHA256과 namespace/operation/binding으로 구분해 최대 32 MiB·32개·5분의 휘발성 캐시로 보관한다. 동일 snapshot의 이후 질의는 corpusId만 전송한다. 서버는 원 자료를 복원한 뒤 전체 inputDigest를 검증한다. 캐시가 사라지면 한 번만 전체 입력으로 재전송하며, 복귀에 필요한 전체 snapshot은 클라이언트가 유지한다.

이 캐시는 정본 저장소가 아니며 서버 DB를 직접 읽는 새 권한을 추가하지 않는다. 따라서 최초 벡터·문서 적재와 클라이언트 snapshot 준비 비용은 남는다. 재시작·퇴출 후에는 안전하게 다시 전송한다. 영구 검색 인덱스, ANN 및 서버 DB 직접 검색은 이번 구현에 포함하지 않는다.

벡터는 후보를 버리지 않고 요청 비용/바이트 기준으로 분할한다. 배치 준비 후 2.5초를 넘으면 추가 원격 배치를 보내지 않고 남은 cosine은 로컬에서 계산한다. 서버 큐에는 참조 전송량이 아닌 복원된 입력 크기를 반영한다. 실제 기기에서 항상 더 빠르다는 성능 보장은 하지 않는다.

## 모드·일관성

plugin_only는 새 검색 연산을 서버에 보내지 않는다. mirror/server_only는 서버 우선이며 연산 실패·구형 fingerprint는 동일 snapshot의 로컬 계산으로 복귀한다. 이 복귀는 서버 정본 읽기 실패를 오래된 로컬 기억으로 대체하는 동작을 추가하지 않는다.

LIBRA와 HAYAKU는 기존 현재 스코프·대화·세계선/manifest binding을 재검증하고, HAYAKU는 검색 원문 변경도 확인한다. Flashback은 스코프·대화·manifest·세계선 변경을 재조회한다. 벡터 배열은 배치 대기 전후 snapshot이 바뀌면 서버 계산값을 사용하지 않는다. 기존 최종 증거·State·세계선 보호는 유지한다. 플러그인 종료 시 검색 클라이언트를 해제하고 서버 종료 시 corpus 캐시를 비운다.

## 검증 및 적용

검색 커널/클라이언트 동기화: `node tools/sync_search_compute.cjs --check`.
공통 SDK 변경 후에는 `node tools/sync_embedded_sdk.cjs`, 커널 변경 후에는 `node tools/sync_search_compute.cjs`로 내장본을 생성한다.

추가 시험:
- search_compute_expansion_runtime_test.cjs: 실제 HTTP, 모드 정책, 순위·점수 일치, snapshot 보존, corpus 재사용/퇴출, 서버 실패, binding 격리 및 input digest.
- search_compute_owner_paths_runtime_test.cjs: 실제 세 플러그인 검색 함수가 새 HTTP 연산을 호출하며 로컬과 같은 결과를 내는지 확인. Flashback 비해시 벡터 및 응답 대기 중 HAYAKU 대화 변경 포함. 저장 모드 선택은 시험 경계에서 주입하며 운영 저장소 이전의 증거로 보지 않는다.

최종 수치는 workspace review_artifacts/search_compute_implementation_20260911/report.md에 기록한다. 운영 DATA와 설치된 플러그인/실행 중 서버를 변경하지 않았다. 사용하려면 수정된 서버와 플러그인을 함께 적용해야 한다. 실제 RisuAI GUI, 외부 모델, 과금 및 실기기 성능은 미검증이다.
