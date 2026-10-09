# 서버 조건부 다중 키 쓰기 — 6차

제품 0.3.32, Storage Protocol 1.9의 선택 capability `conditional-batch.v1`이다.
기존 v1/kv/set·remove·get 및 관리자 계획 경로와 호환한다. capability를 확인하지 않은 클라이언트는 새 API를 사용하지 않는다.

## 요청

인증된 owner가 `POST /v1/kv/batch`로 아래 JSON을 전송한다. 예제의 값은 합성이다.

```json
{
  "namespace":"libra",
  "operationId":"explicit-batch-0001",
  "conditions":[],
  "mutations":[
    {"kind":"set","space":"plugin","key":"example:registry","value":{"items":[]},"expectedRevision":0,"expectedDigest":"","expectedExists":false,"expectedTombstone":false},
    {"kind":"set","space":"plugin","key":"example:head","value":{"throughTurn":0},"expectedRevision":0,"expectedDigest":"","expectedExists":false,"expectedTombstone":false}
  ]
}
```

space는 기존 서버 허용 목록 `plugin` 또는 `local`을 사용한다. 조건은 반드시 직전에 읽은 실제 값에 결속해야 한다. revision 0 예제를 기존 key 덮어쓰기에 사용하면 409다.
각 항목은 space/key와 정확한 `expectedRevision`, `expectedDigest`, `expectedExists`, `expectedTombstone`이 필요하다.
revision 0은 정말 없는 키(`digest=""`, exists=false, tombstone=false)만 뜻한다. tombstone도 revision/digest가 있는 별도 상태다.
revision >0은 SHA256 digest와 exists 또는 tombstone 중 하나가 참이어야 한다.
읽기 전용 `conditions`는 같은 필드에서 kind/value를 생략한다. 변경은 `set` 또는 `remove`; 공개 API의 `purge`는 금지한다.
읽기 조건과 변경을 합쳐 최대 64개, 키 중복 불허, 본문 최대 4MiB다. set에는 value 필수, remove에는 value 불가다.

## 처리·권한

요청 전체가 동일 owner namespace에 속한다. peer read 권한이나 RE:TRACE manager 권한으로 다른 owner에 쓰지 못한다.
같은 namespace DB에서 BEGIN IMMEDIATE → 기존 operation receipt 확인 → 모든 사전 조건 확인 → 모든 키 변경/readback → receipt 저장 → COMMIT이다.
어떤 한 조건이라도 바뀌면 409이고 아무 키도 쓰지 않는다. 조건 만족 중 write/readback 예외도 전체 rollback이다.
HTTP 응답을 못 받았다면 같은 operationId와 같은 요청을 재전송해 동일 영수증을 받는다. 같은 ID로 다른 payload를 보내면 409다.
기존 키가 나중에 변경됐더라도 보관 중인 영수증은 원래 성공을 반환한다. 그것을 현재값의 증거로 사용하지 말고 다시 read한다.

## 응답

`{ok:true,result:{schema:"memory-suite.storage.batch-receipt.v1",namespace,operationId,atomicScope:"single_namespace_sqlite",durable:true,verified:true,committedAt,receipts,checked}}`
receipts는 각 변경의 kind/space/key/revision/digest/tombstone/committedAt이다. checked는 읽기 전용 조건 수다.
기존 operation 영수증 정책(30일 기준, 100,000건 soft cap)을 재사용한다. 영구 무한 idempotency 보장은 아니다. 아주 오래된 불명확 작업을 새 ID로 자동 중복 수행하지 않는다.

## 범위와 검증

단일 namespace SQLite 파일의 원자성이다. 다른 namespace DB, pluginStorage, mirror 두 저장소를 하나로 원자화하지 않는다.
두 실제 서버 프로세스가 같은 DB 파일에 쓰는 경쟁, 두 번째 SQL write 실패, 두 번째 write 중 SIGKILL, 재시작·영수증 재조회·tombstone ABA를 시험한다.
SQLite/OS의 실제 운영 파일시스템과 전원 장애/네트워크 파일시스템 모든 조합까지 검증한 것으로 확대하지 않는다.
LIBRA unified server/mirror writer는 여전히 차단한다. 다음 단계에서 SDK 조건부 API와 모든 canonical/Head/Registry/승계 writer의 commit group을 연결해야 한다.

재현: `node tests/server_conditional_batch_v1_test.cjs`. 시험 child의 장애 hook은 tests/fixtures에만 있으며 제품 HTTP API로 노출하지 않는다.
