# 기억·검색 엔진 정합성 수정 (2026-09-11)

현재 0.3.44 기반 로컬 수정본이다. 표시 버전은 유지하고 실제 소스 해시·알고리즘 식별값으로 구별한다. 운영 DATA와 canonical 기억은 직접 변경하지 않았다.

## 반영 내용

1. **LIBRA 한글 검색 일치**: `tools/libra_recall_tokenizer.cjs`에서 플러그인·서버의 동일 토큰화 코드를 생성한다. 단어 경계를 넘는 한글 bigram을 만들지 않고 한 글자 구간을 보존하며 한글/CJK gram 수를 각각 제한한다. 토큰화 원본 해시를 BM25F fingerprint에 포함하므로 이전 서버를 같은 알고리즘으로 오인하지 않는다. 파생 recall catalog와 block index 버전을 v3로 변경했다. canonical retrieval projection은 유지한다.
2. **공통 검색 helper**: 구조화 질의 문자열, 명시적 intent, 원문·출처 좌표, 증거 범위 검증, whole-word 신호를 하나의 자립형 원본에 통합했다. `recall_evidence_plan_v6`를 HAYAKU·Flashback에 동일하게 내장한다. 기존 자연어 질의 호환 기능과 상위 엔진의 명시적 intent/State 경계는 구분해 유지한다.
3. **Flashback 선택**: 문맥 유사도 모드나 명시적 시간 질의가 아닌 경우, dense·sparse 양쪽 순위에서 다른 후보가 우세한지를 최종 증거 선택에 반영한다. 필수 동반 증거·명시적 대상 우선순위는 유지하고, 최근성 보정만으로 양쪽 검색의 우세 후보가 밀리는 문제를 방지한다. 후보를 영구 제외하지 않으므로 길이 예산 등에 따라 다음 후보로 진행할 수 있다.
4. **Flashback 검색 필드**: 원문의 특정 관계·상태·사건·시간 단어를 정규식으로 분류하던 코드를 제거했다. 원문은 일반 검색 텍스트로 보존한다. 관계·상태는 기존 구조화 fact에서 가져오며, 추가 필드 힌트는 `metadata.recallFields`의 명시적 문자열/문자열 배열을 사용한다. 지원 키는 `relation`, `state`, `event`, `context`, `temporal`이다. 이 힌트는 검색용이며 State 사실을 생성하지 않는다. sparse index 버전은 7이며 metadata 힌트 변경도 캐시 키를 무효화한다.

## 동기화 검사

```powershell
node MemorySuite/PROGRAM/tools/sync_libra_recall_tokenizer.cjs --check
node MemorySuite/PROGRAM/tools/sync_recall_keyword_features.cjs --check
```

`--check`를 생략하면 공통 원본에서 내장 코드를 갱신한다. 갱신은 임시 파일을 거쳐 교체한다. 생성 파일만 수작업으로 고치면 동일성 검사에서 검출된다.

## 검증

- 기존 LIBRA BM25F pilot·실제 HTTP fallback parity, HAYAKU RRF/기억 검색 계약, Flashback hash embedding·질의·State 경계 시험을 다시 실행한다.
- `tests/engine_consistency_v2_runtime_test.cjs`: 한글 한 글자/공백/긴 입력 및 다국어 토큰·점수 parity, helper 3종의 실제 출력 동일성, sparse 필드 역할과 캐시 무효화, 양쪽 저장 순서에서 최종 주입 및 원문 보존을 확인한다.
- 최종 실행 수치와 기존 실패 분류는 workspace `review_artifacts/engine_consistency_fix_20260911/report.md`에 기록한다.
- 실제 RisuAI GUI·외부 모델·과금·실기기 성능은 검증하지 않았다.

## 적용 범위

수정 파일을 사용하려면 갱신된 플러그인을 설치하고 갱신된 서버를 재시작해야 한다. 이 작업에서 사용자 환경의 설치나 서버 재시작은 수행하지 않았다. 서로 다른 알고리즘 fingerprint는 서버 연산 채택을 막고 SDK의 로컬 fallback 정책을 따른다. 구형 기억을 삭제하거나 canonical 기억을 재분석하는 마이그레이션은 추가하지 않았다. LIBRA의 분기·승계·구형 서버 관리 및 RE:TRACE 모드 일치 제한은 이번 검색 정합성 수정의 범위가 아니다.
