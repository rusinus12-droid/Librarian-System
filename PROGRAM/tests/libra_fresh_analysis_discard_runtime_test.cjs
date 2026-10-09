'use strict';
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/libra_unified_runtime_fixture.cjs');
const clone = value => JSON.parse(JSON.stringify(value));
const records = f => [...f.r.values.entries()].flatMap(([key, raw]) => { try { return [{ key, value: JSON.parse(raw) }]; } catch { return []; } });
const read = (f, key) => f.r.values.has(key) ? JSON.parse(f.r.values.get(key)) : null;
const retry = f => f.r.api.retryFailedMemoryAnalysis({ startTurns: [1] });
const results = [];
async function setup() {
  const f = await fixture();
  f.control.modelFails = true;
  assert.equal((await f.run()).failed, 1);
  const work = records(f).find(row => row.key.endsWith(':work:1'));
  const run = records(f).find(row => row.key.endsWith(`:run:${work.value.runId}`));
  work.value.engineVersion = 'legacy';
  work.value.stageIndex = 3;
  work.value.currentDraft = 'DISCARD_THIS_OLD_DRAFT';
  work.value.stageObjects = [{ stage: 'ariadne', content: work.value.currentDraft }];
  work.value.providerBudget.exhaustedReason = 'postflight_output_token_budget';
  work.value.providerBudget.totalCalls = 99;
  f.r.values.set(work.key, JSON.stringify(work.value));
  const archiveKey = work.key.replace(':work:1', ':retired-work:1:previous');
  const archive = { schema: 'libra.retired_memory_work.v1', scopeKey: work.value.scopeKey, workKey: work.key, work: clone(work.value), run: clone(run.value), failedBatch: null };
  f.r.values.set(archiveKey, JSON.stringify(archive));
  f.control.modelFails = false;
  return Object.assign(f, { workKey: work.key, runKey: run.key, archiveKey, oldWork: clone(work.value), oldRun: clone(run.value), oldArchive: archive,
    callsBefore: f.control.calls.length, writesBefore: f.r.storageWrites.length });
}
async function test(name, action) {
  const f = await setup();
  try { await action(f); results.push(name); }
  finally { await f.r.cleanup(); }
}
const assertNoRestore = f => {
  for (const write of f.r.storageWrites.slice(f.writesBefore)) {
    assert.notEqual(write.key, f.runKey, 'old run is never rewritten');
    assert.ok(!write.key.includes(':retired-work:'), 'no archive is written');
    assert.ok(!String(write.value).includes('DISCARD_THIS_OLD_DRAFT'), 'old draft is never copied/restored');
  }
};
const assertDiscarded = f => {
  assert.equal(read(f, f.runKey), null);
  assert.equal(read(f, f.archiveKey), null);
  assert.notEqual(read(f, f.workKey)?.runId, f.oldWork.runId);
  assert.ok(!f.getManifest().runIds.includes(f.oldWork.runId));
  assertNoRestore(f);
};
(async () => {
  await test('manual retry deletes old work/run/archive before a completely new analysis', async f => {
    f.control.onCall = async () => {
      assertDiscarded(f);
      const work = read(f, f.workKey);
      assert.equal(work.stageIndex, 0);
      assert.equal(work.currentDraft, '');
      assert.deepEqual(work.stageObjects, []);
      assert.equal(work.retry, null);
      assert.equal(work.providerBudget, undefined, 'no previous budget is present in the new work');
      return { type: 'success', result: JSON.stringify(f.control.artifact) };
    };
    const result = await retry(f);
    assert.equal(result.completed, 1, JSON.stringify(result));
    assertDiscarded(f);
    assert.equal(f.getHead().throughTurn, 5);
    assert.equal(f.control.calls.length, f.callsBefore + 1);
    const run = records(f).find(row => row.value.runId === f.getManifest().runIds[0] && row.value.commit?.providerBudget).value;
    assert.equal(run.commit.providerBudget.parentOperationId, '');
    assert.notEqual(run.commit.providerBudget.operationId, f.oldWork.providerBudget.operationId);
    assert.equal(run.commit.providerBudget.totalCalls, 1);
    const committed = f.getMemory();
    await retry(f);
    assert.equal(f.control.calls.length, f.callsBefore + 1);
    assert.deepEqual(f.getMemory().canonicalArtifact, committed.canonicalArtifact);
  });
  for (const mode of ['cold_start','manual_scan','interrupted','stale_source','future_engine','current_engine','orphan_run']) {
    await test(`${mode} starts clean without restoring previous work`, async f => {
      const work = read(f, f.workKey);
      if (mode === 'interrupted') work.status = 'interrupted';
      if (mode === 'stale_source') work.sourceDigest = 'old-source-which-will-not-be-reused';
      if (mode === 'future_engine') work.engineVersion = 'unknown-old-engine';
      if (mode === 'current_engine') work.engineVersion = 'libra.unified.v2';
      if (mode === 'orphan_run') f.r.values.delete(f.workKey);
      else f.r.values.set(f.workKey, JSON.stringify(work));
      const result = mode === 'cold_start' ? await f.run() : mode === 'manual_scan' ? await f.r.api.startManualCanonicalScan({ startTurns:[1] }) : await retry(f);
      assert.equal(result.completed, 1, JSON.stringify(result));
      assertDiscarded(f);
      assert.equal(f.control.calls.length, f.callsBefore + 1);
    });
  }
  await test('resuming an interrupted canonical job creates a fresh analysis rather than resuming its old stage', async f => {
    const job = await f.r.api.getCanonicalJobStatus();
    for (const row of records(f)) if (row.value.schema === 'libra.canonical_job.v1' && row.value.jobId === job.jobId) {
      row.value.state = 'interrupted'; f.r.values.set(row.key, JSON.stringify(row.value));
    }
    assert.equal((await f.r.api.resumeCanonicalJob({ jobId: job.jobId })).completed, 1);
    assertDiscarded(f);
  });
  for (const guard of ['foreign_scope', 'foreign_archive', 'committed_run']) {
    await test(`${guard} is rejected before deleting any old record`, async f => {
      if (guard === 'foreign_scope') { const work=read(f,f.workKey);work.scopeKey='foreign';f.r.values.set(f.workKey,JSON.stringify(work)); }
      if (guard === 'foreign_archive') { const archive=read(f,f.archiveKey);archive.scopeKey='foreign';f.r.values.set(f.archiveKey,JSON.stringify(archive)); }
      if (guard === 'committed_run') { const run=read(f,f.runKey);run.commit.status='committed';f.r.values.set(f.runKey,JSON.stringify(run)); }
      const before=[f.workKey,f.runKey,f.archiveKey].map(key=>f.r.values.get(key));
      const result=await retry(f);
      assert.equal(result.failed,1);
      assert.equal(f.control.calls.length,f.callsBefore);
      assert.deepEqual([f.workKey,f.runKey,f.archiveKey].map(key=>f.r.values.get(key)),before);
      assertNoRestore(f);
    });
  }
  for (const fault of ['delete_noop','delete_throw','partial_run_delete','delete_readback','manifest_noop','new_work_noop']) {
    await test(`${fault} prevents model submission, does not restore deleted data, and permits a later fresh retry`, async f => {
      const store=f.r.context.risuai.pluginStorage;
      const get=store.getItem.bind(store),set=store.setItem.bind(store),remove=store.removeItem.bind(store);
      let fired=false,workDeleted=false;
      store.removeItem=async key=>{
        if(!fired&&key===f.workKey&&fault==='delete_noop'){fired=true;return true;}
        if(!fired&&key===f.workKey&&fault==='delete_throw'){fired=true;throw Error('synthetic_delete_error');}
        if(!fired&&key===f.runKey&&fault==='partial_run_delete'){fired=true;throw Error('synthetic_partial_delete_error');}
        const result=await remove(key);if(key===f.workKey)workDeleted=true;return result;
      };
      store.getItem=async key=>{
        if(!fired&&fault==='delete_readback'&&key===f.workKey&&workDeleted){fired=true;throw Error('synthetic_delete_readback_error');}
        return await get(key);
      };
      store.setItem=async(key,value)=>{
        if(!fired&&fault==='manifest_noop'&&String(key).endsWith(':manifest')&&!f.r.values.has(f.runKey)){fired=true;return true;}
        if(!fired&&fault==='new_work_noop'&&key===f.workKey){fired=true;return true;}
        return await set(key,value);
      };
      try{
        const result=await retry(f);
        assert.equal(result.failed,1,JSON.stringify(result));assert.equal(fired,true);
        assert.equal(f.control.calls.length,f.callsBefore);assert.equal(f.getMemory(),null);assertNoRestore(f);
        if(['partial_run_delete','delete_readback','manifest_noop','new_work_noop'].includes(fault))assert.equal(f.r.values.has(f.workKey),false);
      }finally{store.getItem=get;store.setItem=set;store.removeItem=remove;}
      assert.equal((await retry(f)).completed,1);assertDiscarded(f);
    });
  }
  await test('new provider failure leaves only the new failed work and a later manual call discards it', async f => {
    f.control.modelFails=true;
    assert.equal((await retry(f)).failed,1);assertDiscarded(f);
    const firstNewRun=read(f,f.workKey).runId;
    f.control.modelFails=false;
    assert.equal((await f.run()).completed,1);
    assert.equal(records(f).some(row=>row.value.schema===f.oldRun.schema&&row.value.runId===firstNewRun),false);
    assert.equal(f.getHead().throughTurn,5);
  });
  await test('cold start commits the first fresh batch before analyzing the next five turns', async f => {
    f.chat.message.push(...f.chat.message.slice(0,10).map(row=>({...clone(row),chatId:row.chatId.replace(/t(\d+)-/,(_,n)=>`t${Number(n)+5}-`)})));
    f.control.onCall=async()=>{
      const second=f.control.calls.length>f.callsBefore+1,artifact=clone(f.control.artifact);
      if(second){
        assert.equal(f.getHead().throughTurn,5);
        for(const item of [...artifact.entities,...artifact.facts])for(const evidence of item.evidenceSpans)evidence.ref=evidence.ref.replace(/t(\d+)-/,(_,n)=>`t${Number(n)+5}-`);
      }
      return {type:'success',result:JSON.stringify(artifact)};
    };
    const job=await f.run();assert.equal(job.completed,2,JSON.stringify(job));
    assert.equal(f.getHead().throughTurn,10);assertDiscarded(f);
  });
  await test('repeated clicks during a fresh request do not discard active work or submit twice', async f => {
    let started,finish;const ready=new Promise(resolve=>{started=resolve;});
    f.control.onCall=async()=>{started();await new Promise(resolve=>{finish=resolve;});return {type:'success',result:JSON.stringify(f.control.artifact)};};
    const job=retry(f);await ready;
    const active=f.r.values.get(f.workKey);
    try{await assert.rejects(()=>retry(f),/canonical_job_busy/);assert.equal(f.r.values.get(f.workKey),active);assert.equal(f.control.calls.length,f.callsBefore+1);}
    finally{finish();}
    assert.equal((await job).completed,1);assertDiscarded(f);
  });
  console.log(`libra_fresh_analysis_discard_runtime_test: PASS (${results.length} scenarios)`);
})().catch(error=>{console.error(error.message.slice(0,700),String(error.stack).split('\n').filter(line=>/^\s+at /.test(line)).join('\n'));process.exitCode=1;});
