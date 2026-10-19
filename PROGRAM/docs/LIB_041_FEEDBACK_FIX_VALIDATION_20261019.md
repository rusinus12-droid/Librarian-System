# 0.4.1 사용성 피드백 수정 검증 — 2026-10-19

기준 소스는 main `026a9c93cfd5c13161ba2ccdbb158941a9c41103`이다. 이번 수정은 LIBRA 2.3.174와 HAYAKU 3.0.155이며 서버·패키지는 0.4.1을 유지한다. 기존 감사 문서의 배포 판정을 재사용하지 않고 현재 구현과 실행 결과로 확인했다.

## 수정 내용

- LIBRA의 한 owner projection 안에서 같은 저장 본문을 반복해서 가져오던 HTTP 조회를 재사용한다. 프레임을 벗어나면 캐시를 폐기한다. 반환 전에 모든 캡처 키의 실제 본문과 서버의 exists/tombstone/revision/digest를 다시 확인한다. 다른 채팅·동시 조회·다음 요청에 읽기 권한을 넘기지 않는다.
- 최종 재조회는 최대 4개씩 수행한다. 남은 source 예산, 공유 I/O 예산과 read 슬롯에 따라 묶음 크기를 줄인다. 묶음 응답 한도를 넘는 본문은 이미 확보한 예약 안에서 개별 GET으로 확인한다. mirror의 양쪽 본문 읽기와 양쪽 JSON 작업 공간을 모두 계상한다.
- final validation의 scoped resource에도 물리 읽기 예약을 제공한다. 검증 권한이 폐기되어도 진행 중인 실제 I/O의 예약은 물리 종료까지 유지한다. 최종 근거 본문·revision·복원 세대 검증과 Micro 전체 코사인 top-8 선별을 유지한다.
- 명시적 전체 이력 인덱스 구축 중 owner 원본이 변경되면 새 프레임으로 최대 2회 재시도한다. 시도별 보유 자원·저장 lease는 해제하며 누적 source/read 예산을 초기화하지 않는다. 경로·복원 세대·손상·예산 오류는 이 재시도 대상이 아니다.
- LIBRA/HAYAKU는 미검증 Other Ax 스트림이 열린 동안 새 호출을 즉시 거절한다. 전송하지 않은 호출은 submitted=false로 구분하고 GUI에 종료 대기와 RisuAI 설정 안내를 표시한다. 스트림 발견 전에 이미 대기열에 들어온 호출은 실제 EOF/오류까지 기다린다. GUI 갱신 실패가 물리 큐를 해제하지 않는다.
- 첫 설치 안내에 Node.js 22.13.0 이상, 공식 다운로드 주소와 Termux 준비 경로를 추가했다. Windows/macOS 실행기의 기존 대기 처리는 유지한다.

계측·최종 Min 검증에 사용한 LIBRA 소스 SHA-256은 `e5c94287f7eb6c4f5e22d4496b5a45e9b8d054fcbce9a6f8593f129127a390a7`이다.

## 같은 저장 스냅샷의 HTTP 비교

합성 응답으로 정본 5턴과 T6 Micro를 한 번 생성했다. 플러그인을 종료하고 서버를 닫은 뒤 DATA와 플러그인 저장 값·채팅·로어를 복제했다. 동일 스냅샷에서 수정 전/후/후/전 순서로 각각 새 런타임을 시작했다. 각 런타임의 첫 beforeRequest를 콜드, 바로 이어진 2회를 반복 조회로 기록했다. RisuAI 경계는 VM 호스트이며 저장은 실제 HTTP/SQLite, 검색과 최종 패킷 전달은 배포 코드의 실제 hook이다. 임베딩·LLM은 조회 중 호출하지 않았다.

| 조건 | 수정 전 | 수정 후 |
| --- | ---: | ---: |
| 콜드 지연 중앙값, 각 2회 | 2,157.5 ms | 1,871 ms |
| 콜드 HTTP 요청 | 724 | 547 |
| 즉시 반복 지연 중앙값, 각 4회 | 2,356.5 ms | 1,765.5 ms |
| 즉시 반복 HTTP 요청 중앙값 | 886 | 557 |
| 정답 Micro 근거 최종 전달 | 6/6 | 6/6 |
| 조회 중 모델 호출 | 0 | 0 |
| 최종 검증 | 6/6 verified | 6/6 verified |
| 자원 예산 중단 | 0 | 0 |

콜드 HTTP 요청은 24.4% 감소했다. 즉시 반복 중앙값에는 서로 다른 인덱스 준비 상태가 섞여 있으므로 이 수치를 일률적인 속도 향상으로 해석하면 안 된다. 수정 전 반복 4회 중 1회는 이미 RAM 인덱스로 전환되어 466 ms였고, 수정 후 4회는 아직 request_local_corpus였다. request_local_corpus끼리의 반복 지연 중앙값은 수정 전 2,379 ms, 수정 후 1,765.5 ms였다. 백그라운드 작업의 HTTP도 요청 구간의 카운트에 포함되었다.

모든 전달 패킷은 추가 메시지 1개, 직렬화된 전체 메시지 1,890자였다. 정렬된 family/text 근거 목록의 SHA-256은 모든 조회에서 `48e93c0334d54e1015f630941b2d1c3e86d81e219bde7bda7883739ebe9f7564`로 같았다. 한 문항의 반복 근거 전달 검사이며 일반 검색 정확도 수치가 아니다.

추가로 같은 복제 스냅샷에서 실제 백그라운드 RAM 인덱스의 available 상태를 기다린 뒤 버전별 6회를 측정했다. 수정 전 447–476 ms, 중앙값 461 ms; 수정 후 450–474 ms, 중앙값 460.5 ms였다. HTTP 중앙값은 양쪽 모두 251회이며 12/12가 volatile_common_index, 같은 근거 목록, final verified였다. 이 경로에서는 측정상 성능 저하가 나타나지 않았다. 설정·진단 갱신이 겹친 수정 후 첫 조회 2회만 254회였고 모델 호출과 예산 중단은 모두 0이었다.

30개 Micro의 1,024차원 벡터 회귀도 같은 저장 스냅샷으로 비교했다. 마지막 T35 정답은 수정 전·후 각각 4/4 조회에서 실제 RAG 패킷에 도달했다. 수정 후는 전체 30개를 비교하고 상위 8개를 선별했으며, 4회 중앙값은 수정 전 1,939 ms, 수정 후 1,819.5 ms였다. 각 버전 첫 조회의 query embedding 호출 1회 이후 반복 조회는 추가 호출 0회였다. 이는 통제된 벡터·VM 호스트 검사이며 실모델 품질 측정은 아니다.

## 회귀 검사

- Full 회귀 대상 71건의 기능 경로와 버전 검사를 확인했다. 초기 manifest 미갱신으로 실패했던 HAYAKU 버전 1건은 생성 파일 갱신 후 같은 테스트에서 통과했다. 서버 3모드 자원 예산·취소·최종 물리 검증, 전체 인덱스/재시작/증분 currentness, 실제 semantic 접근과 서버 ABA, mirror 복원, Other Ax 물리 큐·오류·타임아웃 검사를 포함한다.
- 생성 metadata와 Min 바인딩 관련 별도 실행 32/32 통과. 마지막 소스에서 읽기 경합·큰 HTTP 본문·공개 스트림 API·byte provenance 7/7 통과.
- 최종 Min 재생성 후 검사: 21/21 통과. source 문자열을 치환하는 주입 방식인 3개 사례만 Min 대상에서 제외했고, 해당 사례는 Full에서 실행했다. Min에서는 실제 공개 API로 plugin_only/server_only/mirror 예산, 큰 본문, ABA 후 재전달, 로컬 GC와 재시작, 기본 reader, Other Ax 종료 대기와 EOF 후 재호출을 확인한다.
- `libra_micro_vector_ranking_regression_test.cjs`: 전체 코사인 top-8, 등록 순서 반전, 선택 후 승자 변경 거절, query embedding 단일 호출 등 통과. 실제 배포 API로 30개 Micro를 출판하고 패킷을 읽는 runtime 비교도 양쪽 모두 통과.
- 6종 Min 생성과 문법 검사 통과. 최종 build report의 각 source SHA-256이 현재 소스와 일치하는지 확인했다. 크기 기준선 초과는 과거 측정값에 대한 표시이며 런타임 자원 예산 인증이 아니다.

재현에 사용한 주요 명령은 다음과 같다. `fake-indexeddb`와 빌드 의존성은 평가 환경의 외부 Node 의존성 경로에서 제공했다.

```sh
node PROGRAM/tools/sync_libra_memory_graph.cjs --check
node --test PROGRAM/tests/libra_memory_graph_read_frame_runtime_test.cjs
node --test PROGRAM/tests/libra_memory_graph_resources_test.cjs PROGRAM/tests/libra_memory_graph_resources_runtime_test.cjs
node --test PROGRAM/tests/libra_memory_graph_local_gc_runtime_test.cjs PROGRAM/tests/libra_memory_graph_corpus_runtime_test.cjs
node --test PROGRAM/tests/libra_memory_graph_incremental_currentness_runtime_test.cjs PROGRAM/tests/libra_memory_graph_semantic_runtime_test.cjs
node --test PROGRAM/tests/otherax_wrapped_stream_queue_runtime_test.cjs PROGRAM/tests/otherax_public_stream_runtime_test.cjs
node PROGRAM/tests/libra_micro_vector_ranking_regression_test.cjs
node PROGRAM/tests/libra_micro_vector_ranking_runtime_test.cjs
node PROGRAM/tools/build_plugins.cjs --profile release --out /tmp/libra-feedback-Min
```

Min 검사는 `LIBRA_TEST_PLUGIN`과 `HAYAKU_TEST_PLUGIN`을 해당 빌드 경로로 지정해 실행한다. 실제 HTTP 비교는 위 fixture의 서버를 정지시켜 만든 비공개 DATA/host 스냅샷을 복제해 실행했으며, 채팅·로어·모델 출력은 두 버전 사이에서 다시 만들지 않았다.

GC 검사는 정상 owner bootstrap audit가 끝난 뒤 원본 불변성의 기준 스냅샷을 잡는다. audit의 정당한 frontier 갱신을 GC 쓰기로 오인하던 검사 문제와, 실제 구축 경합 시 재시도가 없던 제품 문제를 각각 처리했다. IndexedDB에서 6회 재구축해 세대가 회수되고 재시작 후 동일 근거를 읽으며, 원본 host 레코드를 바꾸지 않는 것을 확인했다. local pin 폐기 중의 늦은 읽기는 전달되지 않았다.

개발 중에는 최종 검증 scope에 reserveRead가 빠져 근거를 찾고도 전달이 거절되는 문제가 드러났다. 해당 scope 계약을 보완한 뒤 서버 ABA 거절 후의 정상 hook 전달, 재시작 스냅샷 비교 및 Min 공개 API 경로까지 검사했다. 초기 HAYAKU 버전 검사는 생성 manifest 갱신 전 값 때문에 실패했고 갱신 후 같은 검사가 통과했다.

## 남은 한계

- 이 결과는 합성 기억과 벡터를 사용하는 Linux VM 측정이다. voyage-4-large/deepseek 실모델 품질, 실제 RisuAI/WebView·모바일 heap 한계, 새 Windows/macOS 설치 환경을 이번 검사에서 검증하지 않았다.
- HTTP 요청이 여전히 많다. 콜드 547회이며 10배 가속이나 모든 긴 대화의 지연 상한을 달성했다는 결과가 아니다.
- 물리 중단을 확인할 수 없는 무한 스트림은 플러그인이 안전하게 강제 해제할 수 없다. RisuAI에서 스트리밍을 끄고 실제 생성을 종료해야 하며, 종료 확인이 불가능하면 호스트를 새로고침해야 한다. 이번 수정은 추가 호출과 대기 상태의 혼동을 줄인다.
- plugin_only의 IndexedDB 세대는 원자적 GC를 지원한다. IndexedDB를 사용할 수 없는 legacy host-storage fallback은 안전한 원자적 회수가 없어 이전 영구 페이지를 보존한다. 이를 임의 삭제하거나 캐시가 항상 무제한·항상 5 MB라고 가정하지 않았다.
- 복원 세대 보호와 기존 로컬 업로드 파일 재선택 요구는 유지한다. 이전 저장소와 새 복원본을 자동 결합하지 않는다.
- 원본 평가 스냅샷·로그·서버 인증 데이터는 저장소 밖의 비공개 경로에 보관한다. 이 문서에는 합성 결과 요약만 포함한다. GitHub Release를 게시하거나 실제 사용자 DATA를 변경한 작업이 아니다.
