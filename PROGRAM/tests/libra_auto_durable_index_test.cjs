'use strict';

// 상설(durable) 인덱스 자동 구축: 첫 cold 회수 뒤 한 번, 정본 커밋 뒤 idle 시점에 갱신한다.
// 설정 autoDurableIndex 로 끌 수 있어야 한다.
const assert = require('node:assert/strict');
const {test} = require('node:test');
const { fixture } = require('./fixtures/libra_unified_runtime_fixture.cjs');

const expose = source => {
  const coreAnchor = '      getUnifiedStorageStatus,';
  const apiAnchor = '    async getUnifiedStorageStatus() { return safeClone(await LibraMemoryCore.getUnifiedStorageStatus()); },';
  assert.ok(source.includes(coreAnchor), 'core anchor');
  assert.ok(source.includes(apiAnchor), 'api anchor');
  source = source.replace(coreAnchor,
    '      debugScheduleDurable: (reason = "test", delay = 0) => scheduleDurableIndexBuild(reason, delay),\n' +
    '      debugCancelDurable: () => { if (durableIndexTimer) { clearTimeout(durableIndexTimer); durableIndexTimer = null; } },\n' +
    '      debugDurableState: () => safeClone({ running: durableIndexRuntime().running, scheduled: durableIndexTimerPending(),\n' +
    '        pendingReason: durableIndexRuntime().pendingReason, attempts: durableIndexRuntime().attempts,\n' +
      '        lastResult: durableIndexRuntime().lastResult, yieldRequested: durableIndexRuntime().yieldRequested }),\n' +
    '      debugDelayDurable: ms => { durableIndexRuntime().lastAt=Date.now()+ms; },\n' + coreAnchor);
  return source.replace(apiAnchor,
    '    debugScheduleDurable(reason, delay) { return LibraMemoryCore.debugScheduleDurable(reason, delay); },\n' +
    '    debugCancelDurable() { return LibraMemoryCore.debugCancelDurable(); },\n' +
    '    debugDelayDurable(ms) { return LibraMemoryCore.debugDelayDurable(ms); },\n' +
    '    debugDurableState() { return LibraMemoryCore.debugDurableState(); },\n' + apiAnchor);
};

const waitFor = async (fn, ms = 30000) => {
  const started = Date.now();
  while (Date.now() - started < ms) { const value = fn(); if (value) return value; await new Promise(r => setTimeout(r, 50)); }
  throw new Error('timed out');
};

test('automatic durable build publishes, usage toggles independently, and opt-out stops scheduling',async () => {
  const f = await fixture({ transformSource: expose });
  try {
    const result = await f.run();
    assert.equal(result.completed, 1, JSON.stringify(result));
    const api = f.r.api;

    const settings = await api.getLibraMemorySettings();
    assert.equal(settings.autoDurableIndex, true, '자동 구축은 기본 켜짐');
    assert.equal(settings.useDurableIndex, true, '상설 검색 사용은 기본 켜짐');

    // 첫 cold 회수에서 예약되는 경로는 beforeRequest 회수 안에서만 발생한다.
    // 여기서는 같은 스케줄러를 회수 트리거와 동일한 이유로 직접 호출해 게시까지 확인한다.
    api.debugCancelDurable();
    api.debugScheduleDurable('cold_recall', 0);
    const built = await waitFor(() => { const s = api.debugDurableState(); return s.lastResult ? s : null; });
    assert.equal(built.lastResult.ok, true, JSON.stringify(built.lastResult));
    assert.ok(built.lastResult.windowCount >= 1, '게시된 구간이 있어야 한다');
    const query='은빛 열쇠는 누가 맡지?';
    const on=await api.previewUnifiedMemoryRecall(query);
    assert.equal(on.corpusRead.mode,'durable_common_index');
    await api.saveLibraMemorySettings({...settings,useDurableIndex:false,autoDurableIndex:false});
    api.debugCancelDurable();
    const off=await api.previewUnifiedMemoryRecall(query);
    assert.notEqual(off.corpusRead.mode,'durable_common_index');
    assert.ok(off.memories.length>0,'the unified engine still returns current owner evidence');
    await assert.rejects(()=>api.executeMemoryGraphUnifiedQuery({corpusMode:'required',queryInput:{queryText:query}}),/CORPUS_DISABLED/);

    // 설정을 끄면 다시 예약해도 아무 일도 일어나지 않는다.
    await api.saveLibraMemorySettings({ ...settings, autoDurableIndex: false });
    api.debugCancelDurable();
    const beforeOff = api.debugDurableState().attempts;
    api.debugScheduleDurable('disabled', 0);
    await new Promise(r => setTimeout(r, 400));
    const afterOff = api.debugDurableState();
    assert.equal(afterOff.attempts, beforeOff, '꺼진 설정에서는 구축을 시작하지 않는다');

    console.log(JSON.stringify({ test: 'libra_auto_durable_index', status: 'PASS',
      windows: built.lastResult.windowCount, defaultOn: true, disabledSkips: true }));
  } finally {
    await f.r.cleanup();
  }
});

test('startup and canonical commits automatically publish the last increment even during cooldown',async()=>{
  const f=await fixture({transformSource:source=>expose(source)
    .replace('const DURABLE_INDEX_MIN_INTERVAL_MS = 60000;','const DURABLE_INDEX_MIN_INTERVAL_MS = 100;')
    .replace("scheduleDurableIndexBuild('startup',5000)","scheduleDurableIndexBuild('startup',0)")});
  try{
    await f.run();const api=f.r.api;
    await waitFor(()=>{const s=api.debugDurableState();return !s.running&&s.lastResult?.ok?s:null;});
    const first=await api.previewUnifiedMemoryRecall('은빛 열쇠');
    require('./fixtures/libra_evidence_link_index_fixture.cjs').advance(f,5);
    await f.run();
    assert.ok(api.debugDurableState().pendingReason,'the commit itself queues an increment');
    api.debugCancelDurable();api.debugDelayDurable(600);
    const attempts=api.debugDurableState().attempts;
    api.debugScheduleDurable('last_increment',0);
    await new Promise(r=>setTimeout(r,30));
    assert.equal(api.debugDurableState().attempts,attempts,'cooldown delays the work');
    assert.equal(api.debugDurableState().scheduled,true,'cooldown retains the last dirty request');
    const next=await waitFor(()=>{const s=api.debugDurableState();return s.attempts>attempts&&!s.running&&s.lastResult?.ok?s:null;});
    assert.ok(next.lastResult.buildMode,'the automatic job records its incremental/currentness build decision');
    const last=await api.previewUnifiedMemoryRecall('은빛 열쇠');
    assert.equal(last.corpusRead.mode,'durable_common_index');
    assert.notEqual(last.corpusRead.generation,first.corpusRead.generation);
  }finally{await f.r.cleanup();}
});

test('automatic construction yields to an interactive unified recall',async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const f=await fixture({transformSource:source=>expose(source).replace(
    'const buildMemoryGraphCorpusInto = async (options, volatile, yieldCheck = null) => {',
    'const buildMemoryGraphCorpusInto = async (options, volatile, yieldCheck = null) => { if (!volatile && globalThis.__holdDurableBuild) await globalThis.__holdDurableBuild();')});
  try{
    await f.run();const api=f.r.api;api.debugCancelDurable();
    f.r.context.__holdDurableBuild=()=>gate;
    api.debugScheduleDurable('yield_test',0);
    await waitFor(()=>api.debugDurableState().running);
    const recall=api.previewUnifiedMemoryRecall('은빛 열쇠');
    await waitFor(()=>api.debugDurableState().yieldRequested);
    release();delete f.r.context.__holdDurableBuild;
    const result=await recall;
    assert.ok(result.memories.length>0);
    assert.equal(api.debugDurableState().lastResult.status,'deferred');
    assert.equal(api.debugDurableState().scheduled,true,'the yielded build resumes later');
  }finally{release();await f.r.cleanup();}
});

test('the durable graph room shows the build, holds the usage/automatic switches and a functional full rebuild button',async()=>{
  const {create,pause,until}=require('./fixtures/libra_gui_memory_dom_host.cjs');
  const f=await create('LIBRA');
  try{
    await f.open();await f.click('.sidebar [data-go="settings"]');
    const openGraph=async()=>{const tab=[...f.doc.querySelectorAll('nav.tabs button[role="tab"]')].find(b=>b.textContent.trim()==='상설 그래프');assert.ok(tab,'the memory group has a durable graph tab');tab.click();await pause(200);};
    assert.equal(f.doc.querySelector('input[aria-label="상설 그래프 사용"]'),null,'the switches left the general memory panel');
    await openGraph();
    const cleanup=[...f.doc.querySelectorAll('button')].find(b=>b.textContent.trim()==='이전 페이지 정리');
    assert.ok(cleanup&&!cleanup.disabled,'the durable graph tab exposes manual reclamation');
    assert.equal(f.doc.querySelectorAll('[data-durable-graph-step]').length,4,'the build is shown as four steps');
    assert.match(f.doc.querySelector('[data-durable-graph-status]').textContent,/상설 그래프:/);
    assert.equal(f.doc.querySelectorAll('[data-durable-graph-stats] .stat').length,4);
    const use=f.doc.querySelector('input[aria-label="상설 그래프 사용"]');
    const auto=f.doc.querySelector('input[aria-label="상설 그래프 자동 구축 · 증분"]');
    assert.ok(use&&auto);assert.equal(use.checked,true);assert.equal(auto.checked,true);
    await f.change('input[aria-label="상설 그래프 사용"]',false);
    const save=[...f.doc.querySelectorAll('button')].find(b=>b.textContent.trim()==='설정 저장'&&!b.disabled);
    assert.ok(save,'the settings save control is available');save.click();
    await pause(300);
    assert.equal((await f.api.getLibraMemorySettings()).useDurableIndex,false);
    const rebuild=f.doc.querySelector('[data-durable-graph-rebuild]');assert.ok(rebuild);
    rebuild.click();
    await until(()=>!rebuild.disabled,'full rebuild completion',15000);
    assert.ok([...f.values.keys()].some(key=>key.includes(':memory-graph:v1:corpus:root:')),'the button publishes a real corpus root');
    assert.ok(f.api.debugRuntimeForDisplay().durableGraphPublication?.generation,'manual publication is visible in diagnostics');
    await f.click('.sidebar [data-go="settings"]');await openGraph();
    assert.match(f.doc.querySelector('[data-durable-graph-status]').textContent,/마지막 게시/);
    assert.ok(['게시됨','갱신 대기'].includes(f.doc.querySelector('[data-durable-graph-badge]').textContent),'a published graph reads as published, or as waiting for its next increment');
    assert.deepEqual([...f.doc.querySelectorAll('[data-durable-graph-step]')].slice(0,3).map(node=>node.dataset.stepState),['done','done','done']);
    const status=f.api.inspectDurableGraphStatus();
    assert.equal(status.lastBuild.outcome,'published');assert.ok(status.lastBuild.windowsDone>=1);assert.equal(status.buildProgress,null);
    assert.equal(f.wire.length,0,'derived graph construction invokes no provider or remote service');
    assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});
