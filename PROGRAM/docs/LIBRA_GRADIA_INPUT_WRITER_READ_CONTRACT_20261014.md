# GRADIA 인풋 작성기의 통합 읽기 계약

- 작성일: 2026-10-14 · 갱신: 2026-10-22 · 버전: 1.4

GRADIA 0.25.85의 `plugin_ipc` 연결에서도 같은 미제출 제안·별도 세션·모델 예산·현재성 검사를 사용한다. 이 방식은 server_only 권한 대신 각 owner의 plugin_only native scope와 전용 읽기 채널을 확인한다. [최근 챗과 플러그인 IPC](gradia/RECENT-CHAT-AND-PLUGIN-IPC-20261015.md)를 함께 참고한다.
- 범위: [다음 과제 N04](LIBRA_UNIFIED_MEMORY_ENGINE_NEXT_TASKS_20261014.md). N03의 readonly 공급자를 사용하되 작성기 세션은 별도로 발급한다.

## 사용과 지원 조건

GRADIA 자료 화면에서 **LIBRA 검색 → 통합 메모리 검색 → 연결**을 선택하고 기존 **GRADIA로 인풋 작성하기** 버튼을 사용한다. 입력을 적으면 확장 제안을, 비우면 직전 장면을 참고한 이어쓰기 제안을 만든다. RP 행동 선택과 Novel 세 관점 선택을 모두 지원한다. 선택·편집·번역·복사/전송 흐름은 기존 작성 UI를 사용한다.

GRADIA 0.26.14부터 모든 기억 플러그인은 선택 사항이다. 서버 모드에서는 실제 readonly 서버 권한, 동일 character/chat scope, 수락된 data/reset으로 사용 가능한 owner만 읽는다. LIBRA가 있으면 인증된 RisuAI 채널의 통합 검색을 사용하고, 없어도 HAYAKU·Flashback의 서버 읽기를 사용할 수 있다. 플러그인 모드는 응답하는 owner의 전용 읽기 채널을 사용한다. LIBRA 공급자는 `input_writer_proposal` 지원 목적을 확인하며 다른 LIBRA 검색으로 우회하지 않는다.

첫 기억 조회 전에 선택 공급자를 사용할 수 없으면 원본 대화를 다시 확인한 뒤 외부 기억 없이 작성기를 계속한다. 취소·설정/연결/스코프/원본 변경은 이 대체 경로를 허용하지 않는다. 이미 받아 사용한 기억의 검증 실패, 기억 기반 선택지 재생성 실패는 해당 선택지의 전달을 계속 차단한다. [선택적 기억 연결](GRADIA_OPTIONAL_MEMORY_20261022.md)을 참고한다.

근거 포함 모델 요청은 [모델 문맥·전송 예산](gradia/MODEL-CONTEXT-BUDGET-20261015.md)에 따라 실제 stage preset의 모델·context metadata와 지원하는 텍스트 요청 형식을 검사한다. GPT4o-mini 고정 모델 및 근거 64KiB/전체 요청 128,000바이트 제한은 사용하지 않는다. 작성기에서는 허용된 일반 텍스트 요청 형식으로 JSON을 요구하고 기존 parser가 스키마·선택지 수를 검증한다. generic `json_object`나 새 structured schema를 예산 검사에서 무조건 허용하지 않는다. 모델의 잘못된 출력에 자동 재시도·근거 재포장을 추가하지 않는다. native-only 작성기의 기존 요청 형식은 유지한다.

자동 input handler와 beforeRequest 입력 가로채기는 등록하지 않는다. 공개 `rewriteInput`은 동일 생성 함수를 사용할 수 있지만 전송 권한이나 private 선택지 세션을 반환하지 않으며 종료 시 읽기를 해제한다.

## 미전송 제안과 선택 권한

1. 기존 native context가 이미 닫힌 대화를 읽고 제안을 `unsubmittedProposal`로 취급한다. 제안을 제출된 native turn ID로 꾸미지 않는다.
2. 초기 native snapshot 준비 전부터 연결·취소 경계를 고정한다. 준비 중 연결 해제/취소가 발생하면 이후 검색이나 기본 작성 모델 호출로 이어지지 않는다. 별도 `LibWriterReadConsumer`가 작업별 operation ID, 원래 제안의 SHA-256, 기준 native context digest와 설정/scope를 봉인한다. 빈 이어쓰기의 원래 제안 해시는 빈 문자열에 결속된다.
3. 채널의 `gradia.input-writer-proposal.v1`은 `purpose: input_writer_proposal`, `factAdopted:false`, operation ID, proposal/native digest, queryTruncated만 허용한다. owner는 shape와 목적을 검사하고 발급한 engine metadata에 이를 보존한다. 호출자가 추가한 현재 상태/사실 필드는 허용하지 않는다.
4. 질의는 제안과 직전 장면을 검색 힌트로 쓴다. UTF-8 12,000 bytes까지 사용하고 절단 여부를 보존한다. 해시는 절단하지 않은 원래 제안에 결속된다. 기존 readonly principal의 권한 witness와 LIBRA private compiler의 실제 원본 검증을 함께 거친다.
5. owner가 선택한 근거가 실제 작성기 모델 prompt의 인용 근거에 들어간다. 미전송 제안·생성 선택지는 사건·정본·State가 아니라는 경계를 명시한다. RP/Novel 생성과 사용자가 요청한 번역은 같은 읽기를 사용한다. 재생성은 이전 영수증을 해제하고 새 operation을 만든다.

이 경로는 정본/Micro/State·로어를 쓰거나 역사 재분석·문서 임베딩 생산을 시작하지 않는다. 설정한 기존 native semantic query embedding/cache 정책은 적용될 수 있다. 출력은 사용자가 선택하고 실제 host가 제출한 뒤에야 새 사용자 입력이 되며, 그 다음 셰도우 실행은 독립된 읽기 권한을 얻는다.

## 선택·편집·복사·전송의 검증

선택지 채택과 최종 편집본의 복사/전송에서 `bindDraft`/`finalizeDraft`로 정확한 텍스트와 현재 원본을 검증한다. 검증을 기다리는 동안 editor가 바뀌면 봉인한 출력과 달라져 거부한다. sendChat 권한 확인·상태 표시를 기다린 뒤에도 원본·native context·설정·scope·연결·readonly 권한을 다시 검사한다. 성공한 writer 권한은 sendChat 호출 직전에 소비하고 다음 셰도우로 전달하지 않는다.

취소·재생성·native 대화/캐릭터/로어 변경·원본 교체·설정 변경·연결 해제는 이전 근거/초안 전달을 차단한다. 실패한 재생성 뒤 남아 보이는 이전 선택지는 새 권한으로 내보낼 수 없다. 취소는 대기 중 모델/읽기의 결과 채택을 종료시키며 늦은 응답이 선택지·진단을 복구하지 못한다. 초기 native snapshot과 context 재검사는 취소와 30초 제한을 적용한다. 호스트가 시작한 native RPC 자체를 강제로 중단할 수 있다는 주장은 하지 않는다.

copy 직전 검증의 비동기 대기가 브라우저 clipboard activation을 소모하면 기존 수동 복사 안내를 사용한다. 미리보기로 사람이 이미 본 텍스트를 사후 회수할 수 있다는 주장은 하지 않는다. 복사한 문자열을 나중에 수동 전송할 때는 과거 영수증이나 private 근거 권한이 함께 전달되지 않는다.

## 저장·재사용과 예산

LIBRA 2.4.3부터 검증된 `input_writer_proposal` 요청은 정본·렌즈 기억과 렌더링 문구를 합쳐 최대 3,000자(기존 compiler의 UTF-16 문자열 길이)로 선별한다. `plugin_only`·`server_only` 모두 적용하며, GRADIA가 받은 묶음을 다시 절단하지 않는다. 일반 응답용 요청의 12,000자 상한과 다른 owner가 공유하는 전송 바이트 한도는 유지한다. 더 작은 전송 예산이 있으면 기존 바이트 검사도 함께 적용한다.

선택지/편집 UI를 위한 private 작업 메모리만 결과를 유지한다. generic runtime/confirmation/send 진단은 근거 포함 작업을 가리고, 종료·실패 시 근거·파생 선택지/입력·provider trace·static handoff를 폐기한다. generic checkpoint/response 재사용 저장소에 근거와 파생 입력을 쓰지 않는다. 모델 payload·실제 출력 예약·인용 근거를 최종 모델 문맥에 합산하고 완전한 항목 단위로 포장한다. readonly corpus/raw/metadata 한도와 최종 현재성 검사를 유지한다.

한 세션은 생성 및 명시적 번역을 포함해 최대 16회 모델 호출을 허용한다. 영수증은 기존 채널의 10분 한도와 개별 요청 제한을 따른다. 사용자 선택창을 무제한 오래 유지할 수 있다고 보장하지 않는다. 현재성 검사에는 추가 서버 read/current와 fresh native context 읽기 비용이 들며, 전체 heap 상한이나 실제 호스트 지연 인증은 아니다.

## 재현과 증거 범위

- `node PROGRAM/tests/gradia_input_writer_unified_runtime_test.cjs`: **22 PASS**. 실제 작성 UI의 RP/Novel·번역·정확한 편집본 복사/전송·재생성/실패·취소/늦은 응답·native/scope/원본/권한/설정/연결 변경·미연결 native 흐름·빈 이어쓰기·초기 준비 취소 검사. 공급자의 query/verify는 제어된 fixture다.
- `node PROGRAM/tests/libra_input_writer_unified_native_runtime_test.cjs`: 실제 LIBRA producer/kernel·SQLite·GRADIA 공개 연결 API·작성 버튼·선택/복사/전송 흐름을 결합한다. 읽기만으로 원본/분석 모델 호출이 늘지 않는지, 전송 권한 확인 중 정본을 교체하면 handoff가 거부되는지 검사한다.
- `node --test PROGRAM/tests/libra_input_writer_budget_ipc_runtime_test.cjs`: upstream RisuAI 채널 함수와 실제 LIBRA producer/kernel을 사용해 두 저장 모드의 작성기 3,000자 상한, 정본·렌즈의 동시 전달, 완전한 정본 항목, 일반 응답 예산 유지, 읽기 무변경·렌즈 변경 시 무효화를 검사한다. 서버 모드는 실제 SQLite 서버를 사용한다.
- `node PROGRAM/tests/libra_gradia_unified_read_owner_test.cjs`: 실제 채널 factory의 제안 목적/shape·비채택·영수증·위조·현재성·취소/해제 검사.
- `gradia_three_owner_sdk_test.cjs`: 실제 고정 SDK의 지원 목적 협상·readonly 권한·source/route gate 검사. 기존 evidence bridge는 미연결 작성기가 셰도우 근거를 빌리지 않음을 계속 검사한다.

호스트 채널·모델 응답은 제어된 합성 호스트다. 실제 RisuAI 설치 인증(E4), 실제 모델의 제안 품질·장시간/대규모 성능, 전체 corpus의 durable index와 공통 Cache Manager/Memory Lane은 완료되지 않았다. LIBRA에 퇴역한 Planner/SGA/Input Writer 기능을 복원한 변경이 아니다.
