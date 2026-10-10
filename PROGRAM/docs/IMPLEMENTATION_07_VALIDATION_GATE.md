# 실측 및 릴리스 검증 경계

실제 제공 호스트 `Risuai-2026.8.250.zip`은 수정하지 않았다. 의존성 설치 재시도는 `EAI_AGAIN registry.npmjs.org`로 중단되었고 실제 RisuAI 설치/IPC는 미실행이다. Chromium 직접 HTTP(S) 탐색도 정책에서 차단했다. 7차 GUI 검사는 테스트 전용 Python binding을 통한 실제 로컬 HTTP/SQLite와 SHA-256을 이용한다. 실제 배포 GUI/SDK/제품 함수는 그대로 실행하되 RisuAI·모델 경계는 합성이다. Node SDK/서버 시험은 Node의 실제 WebCrypto/HTTP/SQLite를 사용한다.

`evaluate_wm_semantics.cjs --plan`은 언제나 모델 0호출이다. `--corpus`로 supplied approvedBaseline(schema=libra.wm_approved_baseline.v1, exact sourceRows 10개, v4 artifact)와 referenceContext(characterDescription/personaDescription)를 줄 수 있다. arbitrary previousState 주입은 금지하고 실제 제품 검증/저장/State 경로로 과거를 만든다. baseline fixture dispatch는 external model 호출에 포함하지 않고 별도 기록한다. target 5 U+A의 A/B/C 입력 기준과 prior/read-only reference digest를 기록한다. 현재 도구는 모든 module/로어/custom policy를 지원한다는 인증이 아니다.

실제 모델 실행에는 --live, endpoint, model, 환경변수 MEMORY_SUITE_EVAL_API_KEY, 최대 요청 수가 필요하다. 비밀키를 CLI/제품 문서에 넣지 않는다. 금지/기대 rubric은 모델 프롬프트에 넣지 않는다. 이번 외부 모델 호출은 0회이며 품질 점수나 지연 개선율은 없다.

`check_unified_release_gate.cjs --evidence <json> --output <json>`은 기본값과 파일을 바꾸지 않는 증거 점검 도구다. 실제 host boundary/H06-01–08/source hash, 외부 model+independent assessment, 동일 A/B/C source/prior/reference/model, 결과 전 declared policy 및 runtime restore/mode proof를 확인한다. --require-ready 옵션이면 blocked 결과에 exit 3. 완전한 입력도 수동 릴리스 검토 자격일 뿐 자동 설정 변경 권한이 아니다. 보고서의 자기 선언은 암호학적 실행 인증이 아니므로 raw evidence 검토가 필요하다.

통합 설계 원문의 P7 실측은 미완료이며 기본 legacy/명시 unified 선택을 유지한다. RT-01–06 퇴역·P8 운영 릴리스도 자동 승격하지 않는다.
