# LIBRA 읽기 재사용·구조 탐색기 작업 재개 — 2026-11-10

## 작업 위치

- 워크트리: `C:/Users/rusin/Desktop/Librarian-System/.claude/worktrees/libra-memory-engine-audit-728563`
- 브랜치: `claude/libra-memory-engine-audit-728563`
- 기준 HEAD: `6cc5084bc015e26e90414b8e400a5ae582a80daa`
- 발견 시 수정 파일: `PROGRAM/plugins/LIBRA.js`, `PROGRAM/sdk/MemorySuiteStorageClient.libra.source.js`, `PROGRAM/tools/libra_memory_graph_corpus.cjs`, `PROGRAM/tools/libra_memory_graph_forest.cjs`.
- 발견 시 신규 파일: `PROGRAM/tests/libra_memory_graph_read_reuse_runtime_test.cjs`, `PROGRAM/tests/libra_durable_graph_structure_view_test.cjs`.

위 변경에 임대의 유효 기간 내 로컬 확인, 작업 안 불변 페이지 재사용, 검색 세션의 16 MiB 페이지 캐시, 짧은 루트 읽기 공유와 최종 물리 읽기, 페이지 묶음 읽기, 동시 쓰기 2개, 파생 그래프 쓰기의 원본 캐시 무효화 방지, 그래프 구조 탐색기가 함께 들어 있었다. 인용된 작업 내용과 일치한다. 발견 시 신규 테스트 두 파일은 이미 8/8 통과 상태였다.

## 이번에 이어서 수행한 작업

읽기 재사용 런타임 시험을 보강했다. 서버 검색 캐시를 채운 뒤 실제 대화 원본을 바꾸면 필수 상설 그래프 검색이 거부되는지 확인한다. 추가 시험은 호스트 저장소의 루트를 교체하면 따뜻한 캐시가 있어도 거부하고, 원래 루트를 복원하면 동일한 근거를 다시 전달하는지 확인한다.

## 이번 실행 결과

모든 명령의 작업 디렉터리는 이 워크트리의 `PROGRAM`이다.

| 검사 | 결과 |
| --- | --- |
| `libra_memory_graph_read_reuse_runtime_test.cjs`, `libra_durable_graph_structure_view_test.cjs` | 보강 후 9/9 통과 |
| `libra_memory_graph_corpus_test.cjs`, `libra_memory_graph_corpus_runtime_test.cjs`, `libra_memory_graph_forest_test.cjs` | 37/37 통과 |
| `libra_durable_graph_room_view_test.cjs` | 8/8 통과 |
| `libra_memory_graph_read_frame_runtime_test.cjs` | 5/6 통과, 아래 기준선 비교 참고 |
| `libra_graph_lifecycle_sqlite_test.cjs` | 종료 훅의 임시 폴더 삭제 EPERM으로 실패 |
| `node tools/sync_libra_memory_graph.cjs --check` | 내장 graph 모듈과 원본 일치 |
| `tools/lib/sdk_variants.cjs`의 LIBRA SDK 추출·기대 원본 비교 | 일치 |
| LIBRA 및 SDK의 `node --check`, `git diff --check` | 통과 |

수정본의 고유 시험 합계는 61개 중 59개 통과, 2개 실패다. 최초 8개 실행은 보강 후 9개에 포함하므로 중복 집계하지 않았다.

보강 후 서버 요청 측정은 최초 구축 521회, 변경 없는 재구축 109회, 첫 검색 65회, 반복 검색 40회였다. 같은 시험의 앞선 실행은 529/110/63/40으로 약간 달랐다. 구축·검색 중 `assert` 요청 0회, 반복 검색의 불변 페이지 개별 GET 0회, 검색마다 루트 물리 읽기가 있는지를 단언한다. 이는 합성 fixture의 요청 수다. 인용된 17턴·1,660회 측정과 동일한 데이터나 조건인지 확인하지 않았으므로 직접적인 개선 배수로 환산하지 않는다. 실제 RisuAI 지연이나 브라우저 UI는 이번에 다시 검증하지 않았다.

`read_frame`의 ABA 시험은 바뀐 원본을 거부하는 첫 단언을 통과하지만, 재시도에 따른 변조 횟수를 3회로 기대한 곳에서 실제 1회로 실패한다. 별도 실행에서 fixture가 읽는 LIBRA 소스만 `git show HEAD:PROGRAM/plugins/LIBRA.js`로 바꾸고 동일한 시험을 실행했으며 같은 `1 !== 3` 실패가 재현됐다. 그 기준선 실행도 5/6이었다. 기존 실패를 고쳤거나 전체 회귀가 통과했다고 주장하지 않는다.

기본 임시 디렉터리의 서버 초기화가 한 번 EPERM으로 실패하여, 재실행에서는 해당 프로세스의 TEMP/TMP를 `.development/libra-read-reuse-resume/tmp`로 지정했다. 재실행의 신규 시험은 모두 통과했다. SQLite 폴더 종료 정리 오류는 이 임시 경로에서도 남았다.

## 재개 당시 통합 경계

현재 루트 작업 폴더의 `main`은 `6a708a23`이며 이 워크트리보다 `b80bb689`, `6a708a23` 두 커밋 앞서 있다. 특히 `b80bb689`는 LIBRA 구축 예산·서버 라우트·GUI 수정이므로 통합할 때 이 변경도 보존하고 재검증해야 한다. 이번에는 브랜치를 전환하거나 main에 통합하지 않았다.

성능 패치와 탐색기는 여전히 미커밋 상태다. `.development/`에는 이전 작업자의 많은 측정 자료가 있으므로 이 작업의 새 결과와 구분한다. 커밋·푸시·설치·배포는 수행하지 않았다.

## main 통합

이후 사용자의 메인 커밋 요청에 따라 `6a708a23` 위에 위 네 변경 파일과 신규 테스트 두 파일, 이 문서를 통합했다. 3-way 적용은 충돌 없이 완료했으며 기존 main의 GRADIA 및 LIBRA 수정은 보존했다. main에서 관련 여섯 테스트 파일의 54개 시험이 모두 통과했다. 이 실행의 요청 측정은 구축 517회, 재구축 108회, 첫 검색 64회, 반복 검색 40회였다.

통합 검증 중 기존 `b80bb689`의 SDK 라우팅·그래프 예산 수정이 LIBRA 내장 코드에만 있고 원본 모듈에는 없던 불일치도 발견했다. 통합한 LIBRA 내장 코드를 기준으로 LIBRA SDK 원본 및 `corpus`, `forest`, `resources` 모듈을 동기화하여 기존 main 동작을 보존했다. graph 동기화 검사와 LIBRA SDK 원본 일치 검사가 통과했다. 이 동기화는 실제 플러그인 동작을 추가로 바꾸지 않으며 후속 생성 작업에서 기존 main 수정이 사라지는 것을 막는다.

동기화 후 corpus·forest 단위 시험과 자원 예산 단위·런타임 시험의 56개가 모두 통과했다. 앞선 54개 실행과 중복되는 시험이 있으므로 합산하지 않는다.

작업 임시 자료 `.development/`는 커밋에서 제외한다. 원래 워크트리의 미커밋 변경은 그대로 보존한다. 푸시·설치·배포는 수행하지 않는다.
