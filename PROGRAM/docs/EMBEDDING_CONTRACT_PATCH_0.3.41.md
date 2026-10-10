# 0.3.41 — 1~11차 감사의 잔여 기능 구현

대상: LIBRA 2.3.46, HAYAKU 3.0.56, Flashback 1.0.38, Execution Contract 1.1.0.
0.3.40 전체 감사에서 확인한 기능 공백을 실제 호출부·저장부·설정 화면에 연결했다. 모든 설계 인수 조건이나 실제 서비스 품질의 통과를 뜻하지 않는다.

## 구현

| 감사 항목 | 실제 연결 |
|---|---|
| W10-1/3/5 · PVB/PVR 예산 정책 | LIBRA 신규 설정 초기화와 기존 설정의 명시 적용, 변경 전후 미리보기, 기존 설정 트랜잭션의 저장·재읽기. 기존 프리셋 cap/OFF 보존. 기본 추가 0회. |
| 정본 증액 복구 | 최초 출력 65,536, 복구 98,304, 합산 출력 163,840·입력 240,000·270초. 동일 작업의 ledger와 원문/설정/세계선 재검사. 명시된 truncation 종료와 실제 증가 가능한 cap이 모두 필요. 서버/네트워크 오류·거부·미확정 결과는 자동 재전송하지 않는다. |
| W10-2 · PVR11–15 | Chat Completions, Responses, Anthropic Messages, Gemini/Vertex, Ollama의 bounded SSE/NDJSON 수신. 분할 UTF-8, 종료·거부·usage, EOF·프레임·크기·deadline·취소 검사. 추론 원문을 보관하지 않는다. OtherAx의 미검증 스트림은 기존 보호를 유지한다. |
| W10-4/5 · PVH07 | `hayaku_recovery_extra_calls` ARG와 GUI, 저장 재읽기, 실제 복구·Cold Start·실패 분석 호출에 최대 extra1 연결. 구조 오류에만 추가 호출, 근거·의미 오류와 일반 채팅 capture에는 추가 LLM을 만들지 않는다. |
| W11-2/6 · EID10/EIM01 | 버전된 공식 Voyage 4 같은 공간 등록부. 두 owner가 저장된 생성 descriptor와 대상 descriptor, 실제 벡터를 검증하고 미리본 현재 범위만 metadata-only 이전. 원문·벡터와 최초 모델 이력 보존. LIBRA는 물리 재읽기·롤백 저널·중단 복구, Flashback은 새 세대 전체 재읽기 후 manifest 교체를 사용한다. |
| W10-5/W11-7 · EIG02/07 | Flashback 유지보수 UI의 요청/적용 차원, 실제 요청·usage 미보고·물리 pending·unknown·체크포인트 재개·부분 완료·채택 취소 연결. 실행 종료 기록을 유지보수 저널에 남긴다. |

## 사용

- LIBRA 빠른 설정의 호출·전달 정책에서 **생성 예산**과 **정본 추가 호출**을 선택하고 저장한다. 증액 복구를 쓰려면 프리셋 사용자 상한도 98,304 이상이어야 한다. 작은 상한은 자동 변경하지 않는다.
- 직접 API 스트림은 새 정책의 스트림과 해당 프리셋 스트림을 함께 켠다.
- HAYAKU 설정 → 복구·안전 → **형식 오류 추가 복구**에서 0/1회를 선택한다.
- 임베딩 설정에서 대상 모델을 저장한 뒤 **같은 공간 이전 미리보기 → 메타데이터 이전 적용**을 사용한다. 생성 descriptor가 없는 과거 벡터는 추측해서 승격하지 않는다. 기존 상태로 보존되며 필요시 기존 재임베딩 절차를 사용한다.
- LIBRA의 미완료 이전 저널이 있으면 **중단된 메타데이터 이전 복구**로 이전 상태를 재읽어 복구한다. 다른 쓰기가 끼어들어 소유를 확인할 수 없으면 덮어쓰지 않고 저널을 남긴다.

## 검증과 한계

- `remaining_generation_stream_runtime_test.cjs`: 실제 shared receiver와 LIBRA gateway/정본 budget/설정 저장 경로. 외부 모델 호출 0.
- `remaining_embedding_migration_runtime_test.cjs`: 실제 LIBRA/Flashback 저장과 metadata-only 이전, 원문·벡터 readback, stale preview 거부, rollback 및 중단 저널 복구. 외부 모델 호출 0.
- `hayaku_native_otherax_runtime_test.cjs`: ARG 정책을 저장한 뒤 실제 복구 worker의 1+1 요청, transport 오류 시 중복 호출 금지, 일반 idle 경로 LLM 0.
- Chrome headless의 제품 DOM에서 LIBRA 설정 조작→저장→재읽기, 1440/390px 레이아웃, HAYAKU 선택기, Flashback unknown/resumed/partial 표시를 검사했다. RisuAI 경계는 임시 fixture다.
- 전체 회귀 및 배포 빌더 결과는 작업 폴더 `review_artifacts/remaining_implementation_20260908`의 보고서·로그를 기준으로 한다. 미완료 검증을 성공으로 간주하지 않는다.
- 실제 RisuAI GUI/모델별 원격 스트림/청구/독립 주석 corpus 의미 정확도·recall@k·비용·지연 인수는 별도 실행이 필요하다. 등록부의 프로토콜 테스트가 특정 서비스의 현재 모델 지원을 보증하지 않는다.

## 공식 근거

- [Voyage embeddings](https://docs.voyageai.com/docs/embeddings), [Voyage 4 shared embedding space](https://blog.voyageai.com/2026/01/15/voyage-4/)
- [Anthropic streaming](https://platform.claude.com/docs/en/build-with-claude/streaming)
- [Gemini generation API](https://ai.google.dev/api/generate-content)
- [Ollama streaming](https://docs.ollama.com/api/streaming)
- [OpenAI Responses streaming](https://platform.openai.com/docs/api-reference/responses-streaming)
