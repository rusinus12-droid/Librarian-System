# 임베딩 계약 보완 0.3.40

버전: Server/패키지 0.3.40 · LIBRA 2.3.45 · Flashback 1.0.37 · HAYAKU 3.0.55 · Execution Contract 1.0.1. Storage SDK 1.8.16 및 기존 서버 커밋 보호를 유지한다.

## 수정 내용

- LIBRA의 같은 profile fallback도 종료가 확인된 transient HTTP 오류만 처리한다. 인증·수치·인덱스·차원·절단·결과 불명은 추가 제출하지 않는다. 실제 전송 직전의 body 전체 바이트 제한을 적용하고 Vertex 미보고/부분 보고 usage는 null로 유지한다.
- LIBRA/Flashback은 response를 vector로 축약하기 전에 공급자 보고 truncation을 반려한다. 원문과 기존 정상 벡터는 보존한다.
- Flashback의 논리 timeout 후에도 fetch 또는 body가 미종료면 active/pending을 유지한다. 같은 route의 중복 전송을 차단하고 늦은 settlement로 해제한다. 늦은 벡터는 채택하지 않는다. 공통 작업 원장도 결과 불명인 미종료 요청 뒤 재제출을 거절한다.
- heuristic OFF에서도 hash(query)/hash(raw)로 생성한 복구 채널을 최종 검색에 전달한다. 원격 벡터와 hash 벡터를 직접 비교하지 않으며 기존 worldline/source/개인정보 게이트를 유지한다.
- Flashback contextual 경로도 최초 resolved 차원을 검사한다. 기본 그룹은 조각 index 대신 원본 sourceIndex에 결속한다. 그룹·segment·source span·pooling 버전을 record와 embedding patch에 보존한다. 그룹 정책 v3는 이전 v2와 다른 profile이므로 과거 자료를 현재 설정으로 재표기하지 않는다.
- 성공한 임베딩 batch는 별도의 owner-local checkpoint로 저장하고 정확한 readback을 확인한다. scope/source/profile/route/auth/그룹/분할 설정이 일치하면 VM 재시작 이후에도 성공 batch를 재전송하지 않는다. checkpoint의 오류/오염은 성공으로 숨기지 않는다.

## Checkpoint 경계

`flashback:embedding_checkpoint:v1:` 이름의 로컬 임시 파생 자료다. 공용 기억 DB·원문 정본·portable 원문 백업이 아니며, 다른 owner의 저장소에 쓰지 않는다. scope/source/profile과 권한은 SHA-256 식별값으로 결속하고 원문·API key 자체를 복제하지 않는다. 배치마다 다른 key를 사용해 후속 실패나 다른 작업의 저장으로 성공 batch를 덮어쓰지 않는다.

batch payload 상한은 8 MiB, scope별 최근 checkpoint 상한은 256개다. 새 batch를 시작할 때 7일이 지난 checkpoint를 정리하며 최근 성공을 임의로 비워 새 호출을 진행하지 않는다. 공간이 차면 새 전송 전에 중단한다. 저장소 자체 quota·읽기·쓰기·재조회 실패도 반려 사유다. query/probe/hash 작업은 checkpoint를 생성하지 않는다. 로컬 임시 저장소가 삭제되면 해당 checkpoint를 이용한 재개는 불가능하지만 원문은 별도 보존된다.

기존 완성 기록의 정본 커밋 및 archive source revision 비교는 유지한다. `embeddingProvenance`는 임베딩 파생 필드로 취급하여 원문 변경으로 오인하지 않는다. 기존에 비교 가능한 원격 sidecar가 복원되면 runtime hash overlay가 제거된다.

## 검증 및 남은 범위

`embedding_v111_gap_regression_test.cjs`는 감사 반례의 수정 기대 동작을, `embedding_v111_preservation_test.cjs`는 기존 정상·차단 동작을 검사한다. `embedding_checkpoint_pending_test.cjs`는 재시작 후 재개, 키/source 변경, 저장/재조회 오류, 오염, HTTP body pending, 실제 source→record→저장 readback의 provenance를 검사한다.

실제 RisuAI GUI·실제 공급자 기능/과금·독립 corpus 의미 품질은 이 자동 회귀의 인증 범위가 아니다. 신규 출력 예산의 opt-in 이전 UI, 검증된 streaming, 전체 437조건의 실환경 인수는 기존 잔여 계획으로 유지한다. 이 패치는 사용자의 저장 모드나 모델을 자동으로 바꾸지 않는다.
