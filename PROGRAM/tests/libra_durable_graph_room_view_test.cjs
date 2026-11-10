'use strict';

// The durable graph room prints one view model. These cases cover what the screen has to
// tell apart: a running build, a published graph, a chat past the size limits, a plain
// failure, and another chat's publication that must not be shown as this chat's.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../plugins/LIBRA.js'), 'utf8').replace(/\r\n/g, '\n');
const start = source.indexOf('  // ---- Durable graph room');
const end = source.indexOf('  const buildDurableGraphPanel = ', start);
assert.ok(start > 0 && end > start, 'the view model block is present');
const durableGraphViewModel = new Function(source.slice(start, end) + '\nreturn durableGraphViewModel;')();

const SCOPE = 'scope-a';
const idle = { running: false, scheduled: false, pendingReason: '', attempts: 0, failures: 0, lastAt: 0, lastResult: null, sizeLimited: null };
const base = extra => ({ auto: { ...idle }, buildProgress: null, lastBuild: null, publication: null,
  runtimeIndex: { available: false, scopeKey: '', bytes: 0 }, resident: { maxBytes: 128 * 1048576, totalBytes: 0, byCache: {} }, lastRecall: null, ...extra });
const states = view => view.steps.map(step => step.state);

test('shard counts, bounded partial searches and resumable checkpoints are explicit',()=>{
  const view=durableGraphViewModel(base({publication:{scopeKey:SCOPE,windowCount:129,shardCount:3,pageCount:100,buildMode:'sharded_incremental'},
    auto:{...idle,scheduled:true,lastResult:{status:'checkpointed',windowCount:64,ok:false}},
    lastRecall:{scopeKey:SCOPE,at:Date.now(),mode:'durable_common_index',windowCount:129,shardCount:3,selectedShardCount:1,selectionComplete:false}}),SCOPE);
  assert.match(view.stats[0].meta,/3묶음/);
  assert.ok(view.autoRows.some(row=>row[1].includes('중간 저장')));
  assert.ok(view.recallRows.some(row=>row[1].includes('1 / 3묶음')&&row[1].includes('부분 탐색')));
});

test('nothing built yet reads as waiting, with no step claimed', () => {
  const view = durableGraphViewModel(base(), SCOPE);
  assert.equal(view.badge.text, '확인 전');
  assert.deepEqual(states(view), ['', '', '', '']);
  assert.match(view.statusLine, /게시 확인 전/);
  assert.equal(view.percent, null);
  assert.equal(view.busy, false);
});

test('a running build shows the step it is on and how many windows are done', () => {
  const view = durableGraphViewModel(base({ auto: { ...idle, running: true, pendingReason: 'micro_commit', attempts: 3 },
    buildProgress: { phase: 'enumerating', windowsDone: 3, windowTotal: 12, reusedWindows: 2, enumeratedWindows: 1 } }), SCOPE);
  assert.equal(view.badge.text, '구축 중');
  assert.deepEqual(states(view), ['done', 'active', '', '']);
  assert.match(view.steps[1].text, /3 \/ 12구간 · 재사용 2 · 새로 읽음 1/);
  assert.equal(view.percent, 25);
  assert.equal(view.busy, true);
  assert.equal(view.autoRows[0][1], '실행 중 · 구간 읽기');
  assert.equal(view.autoRows[1][1], '새 Micro 기억');
  const indexing = durableGraphViewModel(base({ auto: { ...idle, running: true }, buildProgress: { phase: 'publishing', windowsDone: 12, windowTotal: 12, reusedWindows: 11, enumeratedWindows: 1 } }), SCOPE);
  assert.deepEqual(states(indexing), ['done', 'done', 'active', '']);
});

test('a published graph that served the last recall completes all four steps', () => {
  const view = durableGraphViewModel(base({
    auto: { ...idle, lastAt: Date.now(), attempts: 1, lastResult: { ok: true, status: 'published', buildMode: 'incremental_reuse', reusedWindowCount: 5, enumeratedWindowCount: 1 } },
    publication: { scopeKey: SCOPE, at: Date.now(), windowCount: 6, pageCount: 40, serializedIndexBytes: 2 * 1048576, buildMode: 'incremental_reuse' },
    lastRecall: { scopeKey: SCOPE, at: Date.now(), mode: 'durable_common_index', windowCount: 6, coldReason: '',
      families: { canonical: { units: 30 }, micro: { units: 80 }, state: { units: 12 }, lore: { units: 9 } },
      delivered: { units: 20, byFamily: { canonical: 9, micro: 7, state: 3, lore: 1 }, usedCharacters: 4800, maxCharacters: 5000,
        loreCharacters: 300, loreCharacterCap: 1000, loreUnitsHeldForMemory: 4, droppedUnits: 6 } }
  }), SCOPE);
  assert.equal(view.badge.text, '게시됨');
  assert.deepEqual(states(view), ['done', 'done', 'done', 'done']);
  assert.match(view.statusLine, /마지막 게시 6구간 · 40페이지/);
  assert.match(view.steps[0].text, /정본 30 · Micro 80 · 상태 12 · 로어 9/);
  assert.match(view.steps[1].text, /6구간 · 재사용 5 · 새로 읽음 1/);
  assert.equal(view.stats[1].value, '40');
  assert.match(view.stats[1].meta, /2\.0 MB/);
  const rows = Object.fromEntries(view.recallRows);
  assert.match(rows['전달한 근거'], /20건 · 정본 9 · Micro 7 · 상태 3 · 로어 1/);
  assert.match(rows['근거 예산'], /4,800 \/ 5,000자 · 예산 밖 6건/);
  assert.match(rows['로어 비중'], /300자 · 기억 우선 상한 1,000자 · 기억 뒤로 미룬 로어 4건/);
});

test('a cold recall says why the durable graph was not used', () => {
  const view = durableGraphViewModel(base({ auto: { ...idle, scheduled: true, pendingReason: 'cold_recall' },
    lastRecall: { scopeKey: SCOPE, at: Date.now(), mode: 'request_local_corpus', windowCount: 4, coldReason: 'superseded_derived_index', families: null, delivered: null } }), SCOPE);
  assert.equal(view.badge.text, '구축 대기');
  assert.equal(states(view)[3], '');
  assert.equal(Object.fromEntries(view.recallRows)['상설 그래프를 쓰지 못한 이유'], '원본이 바뀌어 게시본이 낡음');
  assert.equal(view.busy, true);
});

test('a chat past the size limits is reported as such, not as an endless retry', () => {
  const view = durableGraphViewModel(base({ lastBuild: { phase: 'enumerating', outcome: 'failed' },
    auto: { ...idle, attempts: 4, failures: 1, lastResult: { ok: false, status: 'size_limited', error: 'LIBRA_GRAPH_CORPUS_WINDOW_BUDGET' },
      sizeLimited: { scopeKey: SCOPE, code: 'LIBRA_GRAPH_CORPUS_WINDOW_BUDGET', retryAt: Date.now() + 1000 } } }), SCOPE);
  assert.equal(view.badge.text, '크기 한도 초과');
  assert.equal(view.badge.tone, 'warn');
  assert.deepEqual(states(view), ['done', 'fail', '', '']);
  assert.match(view.statusLine, /크기 한도를 넘어 자동 구축을 쉬고 있습니다/);
  assert.match(view.autoRows[3][1], /30분 뒤 다시 확인/);
});

test('a plain failure marks the step that failed and keeps the error', () => {
  const view = durableGraphViewModel(base({ lastBuild: { phase: 'publishing', outcome: 'failed' },
    auto: { ...idle, failures: 2, lastResult: { ok: false, status: 'failed', error: 'LIBRA_GRAPH_CORPUS_COMMIT_UNVERIFIED' } } }), SCOPE);
  assert.equal(view.badge.text, '구축 실패');
  assert.deepEqual(states(view), ['done', 'done', 'fail', '']);
  assert.match(view.statusLine, /구축 실패 · 자동 재시도 예정 · LIBRA_GRAPH_CORPUS_COMMIT_UNVERIFIED/);
});

test('another chat\'s publication, recall and runtime index are not shown as this chat\'s', () => {
  const view = durableGraphViewModel(base({
    publication: { scopeKey: 'scope-b', windowCount: 9, pageCount: 90, serializedIndexBytes: 100 },
    lastRecall: { scopeKey: 'scope-b', at: Date.now(), mode: 'durable_common_index', windowCount: 9 },
    runtimeIndex: { available: true, scopeKey: 'scope-b', bytes: 5000 },
    auto: { ...idle, sizeLimited: { scopeKey: 'scope-b', code: 'x', retryAt: Date.now() + 1000 } } }), SCOPE);
  assert.equal(view.badge.text, '확인 전');
  assert.deepEqual(states(view), ['', '', '', '']);
  assert.equal(view.stats[0].value, '–');
  assert.equal(view.stats[2].value, '–');
  assert.equal(view.recallRows.length, 0);
});
