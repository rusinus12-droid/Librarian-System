# 실호스트·실모델 검수 계약 — 6차

## 현재 증거

- 실제 제공 소스: Risuai-2026.8.250.zip.
- 입력 ZIP SHA256: `8668650276b5fb2c08005d9a478ee533224e3930d0ca35b8688d68fa91a403e2`.
- 소스 변경 없음. plugin API 정의/구현을 읽고 `corepack pnpm install --frozen-lockfile --ignore-scripts`를 실행했다.
- pnpm 다운로드 중 registry.npmjs.org DNS EAI_AGAIN으로 중단됐다. 실제 앱 빌드/설치/iframe/IPC 결과는 **not_run**이다.
- 외부 모델도 **not_run**이다. 컨테이너의 Provider 응답 fixture와 실모델 평가를 혼용하지 않는다.

읽은 계약: `src/ts/plugins/apiV3/risuai.d.ts`, `v3.svelte.ts`. output listener는 commit된 chat snapshot 및 원래 characterIndex/chatIndex를 제공하므로 비동기 후에는 원래 채팅을 재조회해야 한다.
listener snapshot의 객체 수정으로 호스트 저장이 바뀌는 것으로 취급하지 않는다. messageIndex=-1 및 Auto Continue 후속 변경을 별도 검토한다.
실제 runLLMModel의 allowPlugins/blockPlugins 관계와 source/target IPC 경계를 확인하되 이것은 소스 관찰이지 실행 증명은 아니다.

## 다음 실호스트 시험

격리된 새 RisuAI 데이터 디렉터리에서 기존 사용자 DATA/설정/비밀키를 사용하지 않는다. 제공 host 버전과 앱 빌드 hash를 기록한다.
LIBRA·RE:TRACE를 실제로 설치한 뒤 같은 합성 원문으로 아래 실제 호스트 동작을 실행한다.

| ID | 실제 동작 | 완료 조건 |
|---|---|---|
| H06-01 | output listener + Auto Continue + final output | 최종 5 U+A만 정본, 중간/보조 출력 오인 없음 |
| H06-02 | T12 native branch 및 A/B 재진입 | T1–10 정본만 상속, 원본·미래 교정 불변 |
| H06-03 | 실제 플러그인 IPC로 A→B→C RE:TRACE | ancestor 불변/신규 delta만 추가, T0와 각 세션 T5 구분 |
| H06-04 | 원본 세션이 없는 portable 새 설치 | evidence 검증·새 target identity·교정/분리 재생 |
| H06-05 | 인물 분리→원문 수정→교정 중지 | 잘못된 basis 자동 승인 없음, 원래 정본 보존 |
| H06-06 | legacy 선택/취소 및 실행 중 채팅 전환 | 선택 구간만 모델 호출, 오래된 grant/결과 차단 |
| H06-07 | 화면 재진입/새로고침과 미완료 job | 수동 확인 보존, 임시 pin을 정리가 삭제하지 않음 |
| H06-08 | 실제 Classic/Planner/GRADIA/Input Writer | 같은 authority snapshot, 변경 후 stale 주입 차단 |

관측은 실제 버튼/API 시작과 source/target/ancestor 해시·호출 수·수신 화면까지 포함한다. 구경 가능한 화면만으로 저장 완료라고 하지 않는다.

## 모델 평가 도구

```sh
node tools/evaluate_wm_semantics.cjs --plan --output-dir /path/out
# 아래 명령만 명시적 비용 있는 실제 모델 호출이다. API key는 환경변수에만 둔다.
# MEMORY_SUITE_EVAL_API_KEY를 실행 환경에서 제공한 다음:
node tools/evaluate_wm_semantics.cjs --live --endpoint https://provider.example/v1/chat/completions --model MODEL --case WM-01 --arms A,B,C --max-requests 7 --output-dir /path/out
```

전체 WM-01–16 A/B/C는 계획 dispatch 112회(16×(1+2+4))다. 시작 전에 정확한 케이스/모델/endpoint/총 예산에 동의해야 한다. 기본 명령은 0회다.
본 도구는 실제 배포 LIBRA의 프롬프트·validator·최종 renderer·State를 실행하지만 host와 storage는 메모리에 격리한다. --live라도 실제 RisuAI 앱 전체 인증은 아니다.
Provider가 usage/model을 보고하지 않으면 unknown/null, 가격도 제공 근거 없으면 null이다. wall과 HTTP 시간을 기록하되 model/queue 내부 시간을 꾸미지 않는다.

사전 expected/forbidden rubric을 모델에게 넘기지 않는다. 결과의 인간 평가 칸에서 누락/과잉 확정/identity/knowledge/temporal/currentState를 검토한다.
16개 corpus는 단일 고정 표본 기반이며 통계적 전체 성능 인증이 아니다. 특정 모델의 환각/누락 0%나 항상 1회 성공을 주장하지 않는다.
기본값 전환은 실제 호스트·모델·전환/복원 검수 뒤 별도 결정한다. 이번 도구는 semantic pass 또는 eligibleForDefault를 자동 true로 만들지 않는다.
