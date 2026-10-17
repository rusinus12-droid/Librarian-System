# plugin_only 공통 인덱스의 로컬 세대 회수

대상: LIBRA 2.3.160. 검색 기준은 `dad5e9f`(2.3.159)다. Micro 전체 정확 코사인 top-8, 원본 읽기 예산, 선택 후 digest 대조와 최종 저장 본문·revision 검증은 변경하지 않는다.

## 변경

호스트 `pluginStorage`에는 원자적 CAS/트랜잭션이 없어 키 목록을 보고 이전 페이지를 삭제하는 방법으로는 다른 런타임의 구축·리더를 보호할 수 없다. 그 저장소의 파괴적 GC 차단은 유지한다.

IndexedDB를 사용할 수 있는 환경에서는 **새로 수동 구축하는 plugin_only 공통 인덱스**를 기기·브라우저 origin의 `libra-derived-corpus-v1` DB에 저장한다. 원본 정본·Micro·생산자 벡터·설정은 기존 owner 저장소에 유지한다. 기존 논리 corpus 키와 페이지 형식, 공통 Cache/Index/Memory Lane 및 검색기를 재사용한다.

- 불변 페이지 쓰기와 root 게시에 유효한 build 사용권을 요구한다. root의 예상 이전 값, manifest digest와 모든 전이 참조의 존재·digest를 같은 네이티브 트랜잭션에서 검사한다.
- reader가 root를 처음 읽는 트랜잭션에서 해당 root/manifest를 pin한다. GC는 최신 root와 유효한 reader pin 모두를 보존한다. 같은 root 키에 새 manifest가 게시돼도 이전 reader의 manifest는 따로 보존한다.
- GC의 사용권 관찰·인벤토리·전이 도달성 판정·삭제가 하나의 IndexedDB read/write 트랜잭션에서 수행된다. 다른 탭의 구축 중에는 `blocked_active_builds`로 반환한다. 읽기 중인 이전 세대는 보존하면서 다른 고아는 회수한다. JS Map/타이머를 원자적 저장 보장으로 사용하지 않는다.
- 사용권은 60초이며 20초마다 갱신한다. 만료·취소·scope 삭제 후 늦은 리더/구축자는 읽기·쓰기·게시를 거부한다. 게시 검증 도중 만료도 마지막 root 기록 직전에 다시 검사한다. 취소는 진행 중인 해당 사용권의 네이티브 트랜잭션도 중단한다. 영속 release 실패나 프로세스 종료로 남은 사용권은 만료 후 회수할 수 있다.
- cutoff/view 변경마다 생기는 root가 모두 영구 보존되지 않도록 owner/viewer partition별 최신 root를 추적한다. partition은 최대 16개, 사용권은 scope당 32개, 사용권당 pin은 최대 32개다. 오래된 비활성 인덱스의 퇴출은 원본 기억을 삭제하지 않는다.
- 공통 표, proof, projection v1/v2의 build/window/행 페이지, semantic directory와 벡터 페이지를 추적한다. 24시간 이내의 자기완결 checkpoint는 보존한다.
- 성공한 수동 구축 후 회수를 실행한다. 회수 실패는 게시 성공과 구분해 반환하고 GUI에 표시한다. `collectMemoryGraphGarbage()`도 같은 로컬 경로를 사용한다.
- scope 삭제는 로컬 파생 레코드 삭제와 사용권 취소를 같은 트랜잭션에서 수행한다. 복원/원본 변경 후의 source proof와 최종 readset 검증은 계속 필요하다.
- 정본 의미 directory의 표현 페이지 기록을 순차 처리한다. 기존 `Promise.all`은 기본 32MiB durable 한도에서 8MiB짜리 미확정 읽기 allowance를 여러 개 동시에 예약해, 정본 5개 이상이면 실제 payload가 작아도 `DURABLE_BYTE_BUDGET`으로 중단될 수 있었다. 6개 표현의 실제 resource ledger 회귀가 미변경 2.3.159에서 실패하고 수정본에서 전부 기록됨을 확인했다. 예산·표현 수·순서는 변경하지 않는다.
- 로컬 사용권 검사는 각 페이지 I/O·게시 트랜잭션 안에서 수행한다. 원본 읽기 전후에 별도의 로컬 control 트랜잭션을 중복하지 않는다. 발송 전 `assertIndexCurrent()`의 물리 root 읽기에서도 사용권을 검사하며, 원본 본문 읽기 도중 pin을 취소하는 플러그인 회귀에서 전달이 거부된다. 서버 사용권·owner 본문/route 검증은 유지한다.

## 호환과 한계

**이 패치는 기존 호스트 저장소에 이미 누적된 corpus 페이지를 자동 삭제하지 않는다.** 이전 버전·다른 탭이 그 저장소를 사용하는 상황의 안전한 삭제를 증명할 기능이 호스트에 없기 때문이다. 새 로컬 root가 없으면 기존 호스트 인덱스를 읽고, 다음 명시적 구축부터 새 저장소를 사용한다. 로컬 root가 있는 경우 누락·손상된 로컬 페이지를 같은 이름의 호스트 페이지로 대체하지 않는다.

IndexedDB가 없거나 opaque origin 등으로 `SecurityError`가 발생하면 기존 호스트 경로를 유지하며 실제 삭제는 `blocked_atomic_gc_unavailable`다. `inspectLocalMemoryGraphCorpus()`와 구축 결과의 `persistenceBackend`/`reclamation`으로 구분한다. `mirror`의 호스트 삭제 차단과 `server_only`의 기존 SQLite GC는 유지한다.

새 인덱스는 기기·origin에 종속된 재생성 가능한 자료다. 호스트 백업·다른 기기로의 원본 복구에 포함되는 새 정본 저장소가 아니다. 브라우저 사이트 데이터 삭제 시 다시 구축해야 한다. 원본 전체의 원자적 snapshot이나 완전한 projection coverage를 새로 보장하지 않는다.

조회 중 로컬 페이지 읽기는 기존 durable/read/value 예산에 계상한다. GC 인벤토리는 scope당 8,192레코드·추정 32MiB에서 거부하며, 유지보수의 공통 retained pool에도 예약한다. JSON metadata 보유를 추가 계상한다. 이 한도를 전체 브라우저 heap·IndexedDB 구현 내부 복사·디스크 사용량의 엄밀한 상한으로 해석하지 않는다. 손상·누락·예산 초과·중간 오류에서는 트랜잭션 전체가 중단돼 일부만 삭제하지 않는다.

## 검증

- 커널 13건: 반복 세대 회수, 독립 연결의 reader pin, 같은 root 교체, 만료된 구축자 거부, 새 런타임 복원, 후보 제한/dry-run/checkpoint/다른 scope 보존, dangling 참조와 stale root 거부, 손상·중간 삭제 오류·공유 예산 거부 시 롤백, scope 삭제의 사용권 취소, 게시 검증 도중 만료, 취소 시 진행 중인 쓰기 중단, 영속 release 실패 후 만료 회수.
- 실제 Chromium: 두 탭에서 이전 reader 보존, 삭제 도중 오류의 네이티브 트랜잭션 롤백, reader 해제 후 10레코드 회수, 6회 추가 구축의 회수 전 inventory가 매번 20레코드로 일정, 브라우저 프로세스 재시작 후 저장 root 복원.
- 실제 플러그인 VM 5건: 6회 구축 후 120레코드·약 849.6천 UTF-16 문자로 유지. 원본 scope 레코드 불변, 같은 근거 본문 유지, 재시작 후 추가 provider 호출·재구축 없이 복원, 기존 호스트 인덱스 읽기/보존, 미지원 origin의 삭제 차단과 진단 확인, 원본 읽기 도중 pin 취소 시 전달 거부. VM의 IndexedDB는 `fake-indexeddb`를 사용하며 네이티브 저장 검사는 위 Chromium에서 별도로 수행했다.
- 1,024차원 Micro 30개 중 마지막 의미상 정답이 새 영구 인덱스에서 실제 RAG 패킷에 전달된다. 재시작 후에도 전체 30개 비교·top-8 선택, 질의 임베딩 최대 1회, 문서 임베딩 0회. 실제 provider 품질을 이 합성 벡터 검사로 주장하지 않는다.
- 기존 runtime-index 회귀는 startup vector migration의 지연 marker 쓰기를 인덱스 쓰기로 집계하던 검사 타이밍을 수정했다. 같은 실패가 미변경 2.3.159에서도 재현됐으며, migration 완료를 기다린 후 기존 무쓰기·결과 동일성 검사를 그대로 수행한다.

새 테스트의 Node 의존성은 `PROGRAM/build-support`의 개발 의존성 `fake-indexeddb@6.2.4`다. 배포 플러그인은 브라우저 내장 IndexedDB만 사용하고 이 npm 모듈을 로드하지 않는다.

```bash
npm ci --prefix PROGRAM/build-support
NODE_PATH=PROGRAM/build-support/node_modules node PROGRAM/tests/libra_memory_graph_local_store_test.cjs
NODE_PATH=PROGRAM/build-support/node_modules node PROGRAM/tests/libra_memory_graph_local_gc_runtime_test.cjs
NODE_PATH=PROGRAM/build-support/node_modules node PROGRAM/tests/libra_memory_graph_local_gc_semantic_runtime_test.cjs
node PROGRAM/tests/libra_memory_graph_local_store_browser_test.cjs
```

실제 설치 RisuAI가 IndexedDB를 허용하는지, 대규모 이력의 성능·공간 사용량은 별도 검증 대상이다. 2.3.159의 실모델 지연 수치를 새 로컬 저장소의 실측값으로 인용하지 않는다.

## 같은 실모델 저장 스냅샷 재조회

7.4절에서 한 번 추출한 같은 30턴 스냅샷(SHA-256 `36864288b1a46c8787545e053aefe37040e1e992177e05f3b2e4d67ad0a63522`)을 복제했다. 최초 기억 추출은 `deepseek-v4.1-flash:cloud`, 저장 벡터·이번 질의 임베딩은 `voyage-4-large`(1,024차원)다. 이번에는 기억을 재추출하지 않았다. 원본 스냅샷·로그·키는 저장소 밖 비공개 경로에 보관한다. [비밀값과 본문을 제외한 검증 수치](LIBRA_LOCAL_CORPUS_GC_VALIDATION_20261017.json)를 함께 저장했다.

| 경로 | 질문·반복 | 정답 근거 전달 | 질의 임베딩 | 새 LLM/문서 임베딩 | 예산 중단/예외 |
| --- | --- | --- | --- | --- | --- |
| 기본 RAM 인덱스 | 16개 × 2회 | 30/32 | 16회 | 0/0 | 0/0 |
| 새 영구 인덱스 미리보기 | 16개 × 2회 | 30/32 | 16회 | 0/0 | 0/0 |
| 새 영구 인덱스 실제 beforeRequest | 16개 × 1회 | 15/16 | 16회 | 0/0 | 0/0 |

세 경로의 누락은 기존과 같은 `n03` 하나다. 새 인덱스를 6회 구축해도 매번 264레코드를 보존했고, 구축·회수 자체의 모델 호출은 모두 0회였다. 공개 평가 도구의 실제 요청 훅 재조회에서도 입력 스냅샷 파일이 바뀌지 않았다. 이 훅 실험의 fresh 첫 요청은 인덱스 구축 **전** `request_local_corpus`에서 5,872ms로 성공했으므로 영구 인덱스의 콜드 지연으로 인용하지 않는다.

마지막 만료·취소 경계 보강 뒤 최종 소스와 같은 SHA-256으로 실제 요청 훅을 다시 검사했다. RAM/미리보기는 보강 전의 보완 실행이며 각 소스 digest를 검증 JSON에 기록했다.

이 비교의 VM IndexedDB는 `fake-indexeddb`다. 반복 2회차 미리보기 중앙값은 RAM 195ms, 새 영구 인덱스 285ms였다. 별도 로컬 control 트랜잭션의 중복을 제거하기 전에는 500ms였다. 페이지 I/O/게시 내부 사용권 검사와 최종 물리 root·원본 검증은 유지했다. **이 수치는 네이티브 저장소 성능 인증이 아니며, 영구 인덱스가 준비된 RAM 인덱스보다 빠르다는 결과도 아니다.** 영구 인덱스의 용도는 재시작 뒤 구성 비용의 재사용이다. 실제 설치에서의 저장소 성능 이득은 별도로 측정해야 한다.

공개 도구로 같은 방식을 실행할 수 있다. 환경의 모델 URL·모델명·키를 설정한 뒤, 비공개 스냅샷 경로와 보고서 경로를 지정한다. `local-simulated`는 VM용이며 실제 브라우저 IndexedDB 검사는 위 테스트에서 수행한다.

```bash
NODE_PATH=PROGRAM/build-support/node_modules node PROGRAM/tools/rag_eval/libra_e2e_eval.cjs \
  --require-state --state /private/libra-capture.json \
  --corpus-index local-simulated --index-rebuilds 6 \
  --entrypoint before-request --repeat 1 --json /private/libra-local-index-result.json
```
