# MemorySuite 0.3.34 / LIBRA 2.3.41 — Librarian 전환

기준: 7차 0.3.33 / LIBRA 2.3.40, 통합 설계 v1.6. **개발 전환본이며 실제 RisuAI·외부 모델 운영 인증본이 아니다.**

## 실행 계약

- 신규 생성 stage `librarian`, producer `libra.unified.v2`. 정상 완료 5 U+A당 LIBRA가 제어하는 생성 dispatch 1, 자동 복구 dispatch 0.
- 같은 v4 `finalArtifact`의 본문·리콜 투영·정본 근거를 저장하고 Current Head를 로컬 적용한다. State·벡터 저장 실패는 이미 커밋된 정본을 삭제하지 않는다.
- 수동 재시도는 실패한 구간의 별도 작업/예산으로 1회 생성한다. 원문 수정은 기존 명시 선택·승인과 재검증을 따른다. 상태 재생/저장 복구에는 모델을 호출하지 않는다.
- 구형 `callAriadne/callIto/executeStage/callStateObserver/callStateVerifier` 원격 본문은 퇴역했고 직접 호출은 명시 오류다. 별도 인물 승인은 기존 검증된 receipt 읽기만 허용하며 부족한 근거를 원격 재분석하지 않는다.
- GRADIA SHADOW/AIDE, Planner, Input Writer와 명시 연결 진단은 별도 기능이다. 전체 RP 요청이 항상 1개라는 의미가 아니다. 임베딩과 호스트 내부 물리 retry는 별도 집계/unknown이다.

## 호환과 보존

v4 데이터 schema와 기존 owner namespace/IPC는 유지한다. `libra.unified.v1/v2`는 명시 허용 목록으로 읽고 모르는 버전은 막는다. 기존 정본·출처·승인 원문을 이름 변경으로 재작성하지 않는다. 명시 v1 상태 재생 시 원래 sealed receipt는 별도 불변 seal 키에 먼저 보존한다. 이미 커밋한 v1의 상태 저장 중단은 로컬로 복구한다. 미완료 옛 원격 생성 작업은 새 예산으로 자동 재개하지 않는다.

구형 모드 설정은 Librarian 실행 정책으로 정규화하되 기억 OFF/자동 분석 OFF와 원래 모델·프로필을 보존한다. 새 모델 설정이 없으면 기존 Ariadne 바인딩을 사용한다. 사용자 정의 옛 지침은 읽기 전용 후보로 남기고 선택 검토 후 가져온다. 검토와 설정 저장은 모델 호출 0회다. 저장 기준을 검토 시작 전에 고정하여 외부 변경 덮어쓰기를 방지한다.

기존 v3 prefix는 명시 데이터 경계 확인 후 읽기 보존한다. 선택 구간 전환은 기존 증거를 Librarian으로 재분석한다. 원문이 없거나 이전 상태가 검증되지 않은 구간을 자동으로 꾸미지 않는다. 기존의 연속 prefix 제약 때문에 앞선 실패/공백이 남은 최신 구간 단독 분석은 보류될 수 있다. 순서대로 수동 cold start/실패 복구하거나 명시 legacy 경계를 확인해야 한다.

## GUI

BOOK_UX 보존. 신규 실행 설정은 Librarian 하나와 모델/지침/자료 권한을 표시한다. 상태 화면은 `월드 매니저 · 현재 상태 적용 / 로컬0`이며 옛 Observer 설정은 읽기 전용이다. 인물/세계/서사에 현재 상태 소속을 표시하고 정본 서가·미래 서사 방향과 구분한다. 구형 실행 로그 이름은 역사 그대로 남긴다.

v4 근거 열람은 실제 source→fact→binding→local receipt/현재 Head를 읽으며 존재하지 않는 Observer 기록을 만들지 않는다. 현재 Head의 근거 연결 수를 과거 변경 이력으로 표시하지 않는다. 사용자 교정된 필드는 원래 fact가 현재값의 권위인 것처럼 연결하지 않는다.

## 명시 정본 재생성

plugin_only/main에서 원문이 같은 활성 v4 구간을 명시 재생성하면 Librarian 후보 1개를 만든다. 기존 정본은 유지하고 사용자의 채택 시에만 활성 reference를 교체한 뒤 상태를 재생한다. 취소·후보 거절·source/basis 변경은 이전 정본을 유지한다. 자유 서술로 v4 정본을 직접 편집하는 경로는 계속 차단하며 현재 상태는 교정 저널을 사용한다.

## 지원 경계

plugin_only의 기존 검수된 native branch/RE:TRACE/portable/legacy 선택 전환/identity merge·person split/교정/리콜을 보존한다. server_only는 7차의 현재 main, 상속 없는 all-v4, 단일 writer 정상 분석·승인 원문 수정·현재 교정·로컬 재생·벡터 후처리 범위다. 서버 lineage/portable/legacy 이전/split/rollback/삭제·mirror·분산 다중 writer는 이번에 열지 않았다. 서버 후보 재생성도 미지원이다. 영구 archive 전체 GC는 하지 않는다.

## 증거 수준

제품 전체 JS의 통제된 host/provider 시험, Chromium 실제 GUI, 실제 로컬 HTTP/SQLite 저장 시험을 구분한다. 실제 RisuAI/외부 모델 호출·의미 평가·비용/지연은 이번에 실행하지 않았다. 이전 차수의 시험 숫자를 새 버전의 성적으로 재사용하지 않는다. 상세 최종 실행 로그/숫자는 제품 밖의 구현 보고서·evidence ZIP을 따른다.

`check_unified_release_gate.cjs`는 v2 입력 및 Librarian L군을 검수한다. 옛 A/B/C 생성기는 제품 평가 경로로 재노출하지 않는다. 실제 증거가 없으므로 운영 판정은 blocked이며, 이것은 개발 단일 writer 정책을 legacy로 되돌리는 스위치가 아니다.

설치: 기존 설정과 DATA를 백업하고 PROGRAM/플러그인을 교체한다. 빈 배포 DATA를 기존 DATA에 덮어쓰지 않는다. 구형 binary 재설치만으로 되돌리기는 안전하지 않으며 이전 백업/별도 복원이 필요하다.
