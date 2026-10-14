# LIBRA 차세대 통합 메모리 엔진 — 코드 리뷰·재현 (2026-10-14)

- 검토 브랜치: `codex/libra-memory-network-20261013`
- 검토 HEAD: `83caadd3940e121e4d6198bb3619845b59146e91`
- 비교 기준: `63204736aa96ece2dc31f91ed4d89d07f6e061d3`

검토 종료 시 `git ls-remote`로 동일 HEAD를 확인했다. 이 문서는 해당 runtime snapshot의 분석·재현 기록이며 결함 수정의 증거가 아니다. 현재 작업 추적은 [현황·미완료 문서](LIBRA_UNIFIED_MEMORY_ENGINE_STATUS_20261014.md)를 따른다.

## 변경 범위와 현재 상태

| 커밋 | 변경 |
| --- | --- |
| `4a3853a` | reader 예산 수정, 공통 인덱스 |
| `697a432` | 역의존성, Memory Lane, GC |
| `fe6520c` | 단일 검색·활성화 커널 |
| `a3c76a8` | 근거 컴파일러·readset 검사 |
| `d5775d5` | shadow/cutover 커널, 플러그인 내장 |
| `83caadd` | legacy fence, V05 검사, 설계 v1.6 |

새 모듈 다섯 개의 factory는 LIBRA.js 안에 선언됐으나 런타임에서 생성·호출되지 않는다. `createLibraMemoryGraphIndex/Lane/Query/Compiler/Rollout(...)` 호출은 0건이다. 공개 recall은 기존 `LibraMemoryCore.recall`을 호출하고, beforeRequest도 기존 경로를 사용한다. legacy fence가 실제 기존 cache/A2/ranker 실행 지점에 연결되지 않았다.

따라서 현재 단계는 **커널 추가와 파일 내장**이다. 실제 요청 전환, 공통 durable index/page cache 사용, 임베딩 adapter 연결, 소비자별 최종 dispatch 연결이 남아 있다. 설계 v1.6의 UM5–UM6 완료 문구와 실제 구현 범위를 맞춰야 한다.

관련 위치: [factory 선언](https://github.com/rusinus12-droid/Librarian-System/blob/83caadd3940e121e4d6198bb3619845b59146e91/PROGRAM/plugins/LIBRA.js#L45638), [기존 recall](https://github.com/rusinus12-droid/Librarian-System/blob/83caadd3940e121e4d6198bb3619845b59146e91/PROGRAM/plugins/LIBRA.js#L63645), [공개 recall 호출](https://github.com/rusinus12-droid/Librarian-System/blob/83caadd3940e121e4d6198bb3619845b59146e91/PROGRAM/plugins/LIBRA.js#L83736), [완료 설명](https://github.com/rusinus12-droid/Librarian-System/blob/83caadd3940e121e4d6198bb3619845b59146e91/PROGRAM/docs/LIBRA_UNIFIED_MEMORY_ENGINE_DESIGN.md#L113).

## 재현한 문제

### 1. [P1] 실제 Micro의 미래 턴이 과거 검색에 포함된다

[query.cjs:129](https://github.com/rusinus12-droid/Librarian-System/blob/83caadd3940e121e4d6198bb3619845b59146e91/PROGRAM/tools/libra_memory_graph_query.cjs#L129)는 `unit.sourceSpan.turn`으로 Micro의 시점을 판정한다. 실제 Micro evidence에는 `turn`이 없고, 턴은 record/head/receipt에 있다. [reader.cjs:158](https://github.com/rusinus12-droid/Librarian-System/blob/83caadd3940e121e4d6198bb3619845b59146e91/PROGRAM/tools/libra_memory_graph_readers.cjs#L158)는 그 턴을 unit에 전달하지 않는다.

실제 등록 reader API의 plugin_only와 server_only 합성 호스트 양쪽에서 **turn 6 Micro가 asOfTurn 3 결과에 포함**됐고, `queryComplete:true`가 반환됐다. 새 순수 검색 테스트는 실제 producer가 허용하지 않는 `evidence.turn`을 fixture에 넣어 이 결함을 가린다. native validator의 허용 evidence 필드는 [LIBRA.js:51457](https://github.com/rusinus12-droid/Librarian-System/blob/83caadd3940e121e4d6198bb3619845b59146e91/PROGRAM/plugins/LIBRA.js#L51457)에 있다.

수정: owner 검증을 거친 record/receipt의 턴을 공통 시간 metadata로 보존하고, 후보·중간 경유·basis 적격성에 적용한다. native Micro 형식을 사용하는 회귀 검사가 필요하다.

### 2. [P1] 물리 검증 없이 모델 발송 가능 판정이 나온다

[compiler.cjs:346](https://github.com/rusinus12-droid/Librarian-System/blob/83caadd3940e121e4d6198bb3619845b59146e91/PROGRAM/tools/libra_memory_graph_compiler.cjs#L346)는 `assertPhysicalCurrentness`를 선택 사항으로 취급한다. `currentGraph: async () => previouslyCapturedGraph`만 넘겨도 source 4개를 `verified`로 표시하고 `modelDispatchEligible:true`를 발급한다.

binding 비교는 전달된 graph와의 일치만 확인하므로 이전 snapshot을 그대로 반환하면 실제 owner의 수정·삭제·권한 변경을 확인하지 못한다. private WeakMap handle은 물리적 현재성 증명을 대신하지 않는다.

수정: 최종 발송 승인은 private owner 검증을 필수로 요구하고, 지원하지 않는 환경에서는 발송 가능 상태를 부여하지 않는다.

### 3. [P1] GC가 다른 publisher의 활성 generation을 삭제한다

[store.cjs:196](https://github.com/rusinus12-droid/Librarian-System/blob/83caadd3940e121e4d6198bb3619845b59146e91/PROGRAM/tools/libra_memory_graph_store.cjs#L196)에서 root를 읽어 보존 집합을 만든 뒤 [store.cjs:214](https://github.com/rusinus12-droid/Librarian-System/blob/83caadd3940e121e4d6198bb3619845b59146e91/PROGRAM/tools/libra_memory_graph_store.cjs#L214)에서 삭제할 때 root 변경을 조건으로 검증하지 않는다. `active`는 factory 한 개에만 적용돼 다른 실행기의 게시를 막지 못한다.

동일 store의 정상 build로 만든 A/B generation을 이용한 재현에서, GC가 A root를 읽은 직후 다른 publisher가 B root를 게시하면 GC가 **현재 root B가 참조하는 manifest B를 삭제**했다. 결과는 `currentRoot:"B", currentManifestExists:false`였다. 이미 만들어지고 아직 게시되지 않은 다른 build의 pages도 같은 위험이 있다.

수정: 삭제는 owner 수준의 게시/GC fencing 또는 트랜잭션 조건에 결속해야 한다. root 집합의 변경과 진행 중인 publisher/reader의 보호를 확인하지 못하면 sweep을 중단해야 한다.

### 4. [P1] 검사 도중 폐기된 readset이 검증 성공으로 돌아온다

[compiler.cjs:315](https://github.com/rusinus12-droid/Librarian-System/blob/83caadd3940e121e4d6198bb3619845b59146e91/PROGRAM/tools/libra_memory_graph_compiler.cjs#L315)의 capability 검사는 첫 await 전 한 번뿐이다. `currentGraph()`가 대기하는 동안 `invalidateAll()`을 호출하고 기존 graph를 반환하면 이미 폐기된 readset으로 `status:"verified", modelDispatchEligible:true`가 나왔다. `revoke()`에도 같은 구조가 적용된다.

수정: 각 비동기 경계 뒤와 승인 반환 직전에 issued handle, revoked 상태, compiler epoch를 다시 확인한다.

### 5. [P2] 원본 투영이 잘렸는데 검색을 complete로 보고한다

[query.cjs:511](https://github.com/rusinus12-droid/Librarian-System/blob/83caadd3940e121e4d6198bb3619845b59146e91/PROGRAM/tools/libra_memory_graph_query.cjs#L511)는 Lane과 frontier 종료만 확인하고 graph coverage를 반영하지 않는다.

`nodeLimit:5`로 실제 reader 커널을 실행하면 canonical 1개만 남고 Micro/State/lore에 `node_work_budget`이 기록된다. `projectionComplete:false`인데 검색은 `complete:true, stopReason:"frontier_exhausted"`였다. Rollout은 이를 `deliveryOutcome:"complete"`로 올린다.

수정: projection inventory/coverage의 누락과 미탐색 cursor를 결과에 전달하고, traversal 완료와 지원 corpus 완료를 구분한다. 지원 범위 밖의 누락을 완료로 바꾸지 않는다.

### 6. [P2] source 변경의 역의존성에 postings가 빠진다

[index.cjs:117](https://github.com/rusinus12-droid/Librarian-System/blob/83caadd3940e121e4d6198bb3619845b59146e91/PROGRAM/tools/libra_memory_graph_index.cjs#L117)는 source에 node를 연결하지만, [index.cjs:112](https://github.com/rusinus12-droid/Librarian-System/blob/83caadd3940e121e4d6198bb3619845b59146e91/PROGRAM/tools/libra_memory_graph_index.cjs#L112)는 posting을 node에만 연결한다. `affectedByChanges`는 이 의존성을 전이적으로 확장하지 않는다.

정본 source 변경을 전달하면 영향을 받는 의미 node와 edge는 나오지만 **affectedPostingKeys가 빈 배열이고 requiresGlobalDfRefresh가 false**였다. 이 결과로 증분 갱신하면 수정·삭제된 자료의 lexical/entity/predicate/time posting 및 DF가 남을 수 있다.

수정: source/representation 변경에서 해당 node의 postings까지 의존성을 확장하고, lexical 변경의 DF 갱신을 요청한다.

### 7. [P2] 출력 문자 예산이 실제 packet 크기를 제한하지 않는다

[compiler.cjs:142](https://github.com/rusinus12-droid/Librarian-System/blob/83caadd3940e121e4d6198bb3619845b59146e91/PROGRAM/tools/libra_memory_graph_compiler.cjs#L142)는 본문 길이만 계산한다. [compiler.cjs:292](https://github.com/rusinus12-droid/Librarian-System/blob/83caadd3940e121e4d6198bb3619845b59146e91/PROGRAM/tools/libra_memory_graph_compiler.cjs#L292)는 이후 header·역할 라벨·번호·줄바꿈을 추가한다.

`maxCharacters:32`에서 `usedCharacters:31`로 승인된 결과를 render하면 **packet은 129자**였다. 최종 packet을 소비자가 다시 자르면 정본이 실제 출력되지 않았는데도 Micro가 이미 흡수된 것으로 남는 문제가 이어질 수 있다.

수정: 소비자 envelope 비용을 포함해 최종 render 크기로 admission을 결정하고, 실제 남은 출력에 맞춰 흡수와 consumed readset을 확정한다.

### 8. [P2] V05 결정성 검사가 존재하지 않는 필드를 비교한다

[rollout.cjs:210](https://github.com/rusinus12-droid/Librarian-System/blob/83caadd3940e121e4d6198bb3619845b59146e91/PROGRAM/tools/libra_memory_graph_rollout.cjs#L210)의 `c.bestActivation`, `selected.bundle.bundleDigest`, `packet.packetDigest`는 실제 반환 객체에 없다. 실제 candidate는 `score`를 갖고, bundle digest는 readset handle에만 있으며 packet digest는 생성하지 않는다.

재현 결과는 네 pass 모두 candidateDigest만 있었지만 `deterministic:true`였다. bundle/packet은 `undefined === undefined`로 통과하고 activation 값은 JSON에서 빠진다. 또한 index/query는 cache page를 설치·읽지 않으므로 현재 실행은 실제 warm hit/LRU/독립 factory 재시작의 검증도 아니다.

수정: 실제 candidate 점수와 witness, bundle 내용, 최종 rendered packet의 digest를 비교한다. 실제 캐시 접근·축출과 새 실행기 재시작을 포함하는 통합 검사를 별도로 실행해야 한다.

## 실행한 검증

- 그래프 테스트 9개 파일 통과: identity, reader contract, pages, store, index, query, compiler, rollout, assembly.
- 실제 등록 API를 사용하는 reader/pages/store runtime 검사 통과: plugin_only/server_only 합성 호스트, 실제 storage bridge, 재시작·오염·취소·게시 경합.
- LIBRA.js 문법 검사와 graph embed 동기화 검사 통과.
- 위 8개 문제는 별도 probe로 재현. Micro 시점 문제는 실제 등록 API에서 읽은 native 형식의 projection을 새 Query에 넣어 두 mode에서 재현했다.
- 설치된 RisuAI 호스트의 실행·성능 인증은 수행하지 않았다. 새 커널을 실제 beforeRequest/소비자 dispatch에 연결하는 검사는 기존 suite에 없다.

재현은 아래 저장소 상대경로 기준의 Node 명령으로 실행한다. GC와 readset probe의 owner callback은 mock이며, native Micro 재현은 등록 reader API 결과를 Query 커널에 직접 주입한다. 실제 새 beforeRequest/dispatch 통합 증거로 승격하지 않는다.

## 권장 순서

P1의 시간·물리 검증·폐기 경계와 GC 경합부터 수정한다. 이어서 coverage, 역의존성, 실제 출력 예산을 고친 뒤 V05를 실제 cache/재시작 검사로 교체한다. 이 경계가 확인된 다음 실제 요청의 engine selection과 private owner adapter를 연결하고, shadow 평가를 거쳐 legacy retirement를 진행한다. 설계 문서의 완료 표시는 각각의 실제 호출·검증 범위에 맞춰 갱신한다.

## 저장소에서 재현하기

Node.js와 이 저장소 테스트 의존성이 준비된 환경에서 저장소 루트의 `PROGRAM`으로 이동한다. 아래 두 명령은 현재 테스트 fixture의 helper를 활용하는 리뷰 probe다. 정식 회귀 suite에 D01–D08을 추가한 상태가 아니므로 구현 수정 뒤에는 기대 결과와 fixture를 갱신해야 한다. 서버 fixture는 임시 HTTP/SQLite 호스트를 사용한다.

### 커널·owner mock probe (D02–D08)

```sh
cd PROGRAM
node <<'NODE'
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const root = process.cwd();
const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');
const tool = name => require(path.join(root, 'tools', 'libra_memory_graph_' + name + '.cjs'));
function helpers(name, names) {
  const filename = path.join(root, 'tests', 'libra_memory_graph_' + name + '_test.cjs');
  const src = fs.readFileSync(filename, 'utf8');
  const mod = new Module(filename); mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  mod._compile(src.slice(0, src.lastIndexOf('(async () => {')) + '\nmodule.exports = {' + names.join(',') + '};', filename);
  return mod.exports;
}
(async () => {
  const { makeSnapshot, runPipeline } = helpers('compiler', ['makeSnapshot', 'runPipeline']);
  const { graph, queryResult, compiler } = runPipeline(makeSnapshot());
  const selected = compiler.select(queryResult, graph, { maxCharacters: 4096 });
  const unchecked = await compiler.validateConsumedReadSet(selected.readSetHandle, { currentGraph: async () => graph });
  console.log(JSON.stringify({ probe: 'no_physical_verifier', modelDispatchEligible: unchecked.modelDispatchEligible, verifiedSources: unchecked.verifiedSourceCount }));
  let release;
  const pending = compiler.validateConsumedReadSet(selected.readSetHandle, { currentGraph: () => new Promise(resolve => { release = resolve; }) });
  compiler.invalidateAll(); release(graph);
  console.log(JSON.stringify({ probe: 'invalidate_during_verification', result: await pending }));

  const second = runPipeline(makeSnapshot());
  const short = second.compiler.select(second.queryResult, second.graph, { maxCharacters: 32, maxUnits: 10 });
  const packet = second.compiler.render(short);
  console.log(JSON.stringify({ probe: 'rendered_budget', budget: 32, usedCharacters: short.bundle.budget.usedCharacters, packetCharacters: packet.characterLength }));

  const pages = tool('pages')({ fingerprint: sha256 });
  const identity = tool('identity')({ fingerprint: sha256 });
  const readers = tool('readers')({ identity, digestClaim: c => sha256(JSON.stringify(c)) });
  const snap = makeSnapshot();
  const small = { ...readers.project(snap, { nodeLimit: 5 }), scopeKey: snap.frame.scopeKey, readerFrame: snap.frame };
  const index = tool('index')({ pages, fingerprint: sha256 });
  const lane = tool('lane')({ index, pages });
  const query = tool('query')({ index, lane, pages, fingerprint: sha256 });
  const partition = JSON.stringify({ owner: snap.frame.owner, scopeKey: snap.frame.scopeKey, viewer: 'owner_reader' });
  const generation = pages.generation(small, { partition, view: snap.frame });
  const compiled = index.compile(small, { partition, generation });
  const frame = query.sealQueryFrame({ owner: snap.frame.owner, scopeKey: snap.frame.scopeKey, queryText: 'silver ring' });
  const result = query.retrieve(query.openView(small, compiled, frame));
  console.log(JSON.stringify({ probe: 'node_budget_coverage', projectionComplete: small.coverage.projectionComplete, familyReasons: small.coverage.families, queryComplete: result.complete, stopReason: result.stopReason, families: result.candidates.map(c => c.family) }));
  const source = graph.nodes.find(n => n.layer === 'source' && graph.units.some(u => u.family === 'canonical' && graph.nodes.some(m => m.id === u.nodeId && m.sourceId === n.id)));
  const fullIndex = index.compile(graph, { partition, generation });
  console.log(JSON.stringify({ probe: 'source_reverse_dependencies', impact: index.affectedByChanges(fullIndex, ['source:' + source.id]) }));

  const rolloutHelper = helpers('rollout', ['makeSnapshot', 'buildEnv']);
  const rolloutEnv = rolloutHelper.buildEnv(rolloutHelper.makeSnapshot());
  const det = rolloutEnv.rollout.verifyColdWarmEvictionDeterminism({ graph: rolloutEnv.graph, queryInput: { queryText: 'silver ring alice' } });
  console.log(JSON.stringify({ probe: 'v05_compared_digests', report: det }));

  const storePages = tool('pages')({ fingerprint: sha256 });
  const store = tool('store')({ pages: storePages, fingerprint: sha256 });
  const values = new Map([['source-1', 'v1']]);
  const simple = { schema: 'libra.memory_graph_projection.v1', scopeKey: 'scope-alpha', readerFrame: snap.frame, coverage: { inventory: { inventoryComplete: false } }, nodes: [{ id: 'n1', bindingId: 'b1' }], edges: [{ id: 'e1', bindingId: 'be1' }], bases: [{ id: 'ba1', bindingId: 'bba1' }], units: [{ nodeId: 'n1', family: 'canonical', text: 'active unit' }] };
  let flipOnRead = null;
  const owner = {
    publication: 'test_runtime_ordered_partial', check() {},
    async read(key) { const raw = values.get(key) ?? null; if (flipOnRead && key === flipOnRead.manifestKey) { values.set(flipOnRead.rootKey, flipOnRead.rootRaw); flipOnRead = null; } return raw; },
    async putImmutable(key, raw) { values.set(key, raw); },
    async capture(keys) { return keys.map(key => ({ key, raw: values.get(key) ?? null })); },
    async assertCaptured(pin) { for (const p of pin) if ((values.get(p.key) ?? null) !== p.raw) throw new Error('source_changed'); },
    async commitRoot({key, raw}) { values.set(key, raw); },
    async listKeys(prefix) { return [...values.keys()].filter(k => k.startsWith(prefix)); },
    async deleteStale(key) { values.delete(key); }
  };
  const sourceOptions = { limit: 20, nodeLimit: 2048 };
  const build = jobToken => store.build({ snapshot: async () => ({ graph: simple, sourceKeys: ['source-1'] }), owner, sourceOptions, pageBytes: 1024, jobToken });
  await build('A');
  const rootKey = [...values.keys()].find(k => k.includes(':root:'));
  const aRaw = values.get(rootKey), aRoot = JSON.parse(aRaw);
  await build('B');
  const bRaw = values.get(rootKey), bRoot = JSON.parse(bRaw);
  values.set(rootKey, aRaw);
  flipOnRead = { rootKey, manifestKey: aRoot.manifestKey, rootRaw: bRaw };
  const swept = await store.collectGarbage({ owner, scopeKey: 'scope-alpha' });
  console.log(JSON.stringify({ probe: 'gc_concurrent_publisher', currentRoot: JSON.parse(values.get(rootKey)).publicationToken, currentManifestExists: values.has(bRoot.manifestKey), deletedCurrentManifest: swept.deletedKeys.includes(bRoot.manifestKey) }));
})().catch(err => { console.error(err); process.exitCode = 1; });
NODE
```

### Native Micro reader + Query probe (D01)

위와 동일한 `PROGRAM` 디렉터리에서 실행한다.

```sh
node <<'NODE'
'use strict';
const root = process.cwd();
const { fixture, QUOTE } = require(root + '/tests/fixtures/libra_memory_graph_reader_fixture.cjs');
const sha256 = text => require('node:crypto').createHash('sha256').update(text).digest('hex');
const tool = name => require(root + '/tools/libra_memory_graph_' + name + '.cjs');
(async () => {
  for (const mode of ['plugin_only', 'server_only']) {
    const host = await fixture({ mode });
    try {
      const graph = JSON.parse(JSON.stringify(await host.project({ nodeLimit: 2048 })));
      const pages = tool('pages')({ fingerprint: sha256 });
      const index = tool('index')({ pages, fingerprint: sha256 });
      const lane = tool('lane')({ index, pages });
      const query = tool('query')({ index, lane, pages, fingerprint: sha256 });
      const partition = JSON.stringify({ owner: graph.readerFrame.owner, scopeKey: graph.scopeKey, viewer: 'owner_reader' });
      const generation = pages.generation(graph, { partition, view: graph.readerFrame });
      const compiled = index.compile(graph, { partition, generation });
      const frame = query.sealQueryFrame({ owner: graph.readerFrame.owner, scopeKey: graph.scopeKey, worldlineId: graph.readerFrame.worldlineId, queryText: QUOTE, asOfTurn: 3 });
      const result = query.retrieve(query.openView(graph, compiled, frame));
      const micro = graph.units.find(u => u.family === 'micro');
      console.log(JSON.stringify({ probe: 'native_micro_as_of', mode, actualMicroTurn: host.active.turn || host.active.record?.turn, sourceSpan: micro.sourceSpan, requestedAsOfTurn: 3, futureMicroReturned: result.candidates.some(c => c.nodeId === micro.nodeId), queryComplete: result.complete }));
    } finally { await host.cleanup(); }
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
NODE
```

### 조사 HEAD의 결과

```jsonl
{"probe":"no_physical_verifier","modelDispatchEligible":true,"verifiedSources":4}
{"probe":"invalidate_during_verification","status":"verified","modelDispatchEligible":true}
{"probe":"rendered_budget","budget":32,"usedCharacters":31,"packetCharacters":129}
{"probe":"node_budget_coverage","projectionComplete":false,"omittedFamilies":["micro","state","lore"],"queryComplete":true,"stopReason":"frontier_exhausted"}
{"probe":"source_reverse_dependencies","affectedPostingKeys":[],"requiresGlobalDfRefresh":false}
{"probe":"v05_compared_digests","deterministic":true,"bundleAndPacketDigestFieldsPresent":false}
{"probe":"gc_concurrent_publisher","currentRoot":"B","currentManifestExists":false,"deletedCurrentManifest":true}
{"probe":"native_micro_as_of","mode":"plugin_only","actualMicroTurn":6,"requestedAsOfTurn":3,"futureMicroReturned":true,"queryComplete":true}
{"probe":"native_micro_as_of","mode":"server_only","actualMicroTurn":6,"requestedAsOfTurn":3,"futureMicroReturned":true,"queryComplete":true}
```

위 JSON은 probe 출력의 핵심 필드를 요약한 기록이다. raw DTO 전체·지원되지 않은 owner authority 플래그를 최종 물리 proof로 사용하지 않는다.
