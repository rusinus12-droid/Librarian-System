'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto'), fs = require('node:fs'), path = require('node:path');
const source = fs.readFileSync(process.env.COMPUTE_SDK_SOURCE_FILE || path.join(__dirname, '../sdk/MemorySuiteComputeClient.source.js'), 'utf8');
const create = new Function(`${source}\nreturn createMemorySuiteComputeBridge;`)();
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
const digest = value => crypto.createHash('sha256').update(canonical(value)).digest('hex');
const response = (payload, status = 200) => ({ ok:status < 300, status, text:async () => JSON.stringify(payload) });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const cleanupStarted = (entered, work) => Promise.race([entered.promise, work.then(
  () => { throw new Error('Job completed without entering expected cleanup'); },
  () => { throw new Error('Job failed without entering expected cleanup'); }
)]);

function harness(overrides = {}) {
  const operation = 'test.background-cleanup.v1', fingerprint = 'background-cleanup-v1';
  const jobs = new Map(), cancellations = [], calls = [], submitted = [];
  const state = { fault:'status_503', cancelFault:'', configuredUrl:'http://127.0.0.1:47630', bootstrapCount:0,
    rejectFirstSubmit:false, localCalls:0, onStatus:null, onCancel:null, ...overrides };
  const publicJob = (job, jobState = 'succeeded') => ({ schema:'memory-suite.compute.job.v1', jobId:job.jobId,
    namespace:'test', operation, operationId:job.body.operationId, algorithmFingerprint:fingerprint,
    inputDigest:job.body.inputDigest, binding:job.body.binding, state:jobState });
  let bridge;
  const fetch = async (url, init = {}) => {
    calls.push({ url, method:init.method, authorization:init.headers?.Authorization });
    if (url.endsWith('/bootstrap')) {
      state.bootstrapCount++;
      return response({ ok:true, schema:'memory-suite.compute.bootstrap.v1', version:'test', url:new URL(url).origin,
        token:`compute-only-${state.bootstrapCount}`, authorization:{ pluginId:'cleanup_test', namespace:'test', roles:['compute'] },
        capabilities:{ 'compute.v1':true, 'compute-jobs.v1':true }, limits:{ maxDeadlineMs:5000 },
        operations:[{ operation, algorithmFingerprint:fingerprint, maxDeadlineMs:5000 }] });
    }
    assert.match(init.headers.Authorization, /^Bearer compute-only-/);
    if (url.endsWith('/jobs')) {
      if (state.fault === 'submit_503') return response({ok:false,error:'submit unavailable',code:'TEST_SUBMIT_UNAVAILABLE'},503);
      if (state.rejectFirstSubmit) { state.rejectFirstSubmit = false; return response({ ok:false, error:'rotated', code:'TEST_AUTH' },403); }
      const job = { jobId:`cleanup_job_${jobs.size + 1}`, body:JSON.parse(init.body) };
      jobs.set(job.jobId, job); submitted.push(job.jobId);
      return response({ ok:true, schema:'memory-suite.compute.job-response.v1', result:publicJob(job,'queued') });
    }
    const match = url.match(/\/jobs\/([^/]+)(?:\/(result|cancel))?$/);
    assert.ok(match, url);
    const job = jobs.get(decodeURIComponent(match[1])); assert.ok(job);
    if (match[2] === 'cancel') {
      cancellations.push({ jobId:job.jobId, url, authorization:init.headers.Authorization, signal:init.signal });
      if (state.onCancel) await state.onCancel(job);
      if (state.cancelFault === '503') return response({ ok:false, error:'cancel unavailable', code:'TEST_CANCEL_UNAVAILABLE' },503);
      if (state.cancelFault === 'hang') return new Promise(() => {}); // transport deliberately ignores AbortSignal
      if (state.cancelFault === 'hang_body') return { ok:true, status:200, text:() => new Promise(() => {}) };
      if (state.cancelFault === 'invalid_json') return { ok:true, status:200, text:async () => 'invalid-json' };
      return response({ ok:true, schema:'memory-suite.compute.cancel-response.v1', result:publicJob(job,'cancelled') });
    }
    const fault = typeof state.fault === 'function' ? state.fault(job) : state.fault;
    if (match[2] === 'result') {
      const result = { value:job.body.input.value };
      return response({ ok:true, schema:'memory-suite.compute.result-response.v1', result:{
        ...publicJob(job), schema:'memory-suite.compute.result.v1', result,
        resultDigest:fault === 'bad_digest' ? '0'.repeat(64) : digest(result)
      } });
    }
    if (state.onStatus) await state.onStatus(job, bridge);
    if (fault === 'status_503') return response({ ok:false, error:'status unavailable', code:'TEST_STATUS_UNAVAILABLE' },503);
    if (fault === 'timeout') return new Promise(() => {});
    if (fault === 'foreign_status') return response({ ok:true, schema:'memory-suite.compute.job-response.v1', result:{...publicJob(job),jobId:'untrusted_foreign_job',namespace:'foreign'} });
    return response({ ok:true, schema:'memory-suite.compute.job-response.v1', result:publicJob(job, ['failed','cancelled','expired'].includes(fault) ? fault : 'succeeded') });
  };
  bridge = create({ namespace:'test', pluginId:'cleanup_test', defaultMode:'prefer_server', backgroundProbe:false,
    disposeCancelGraceMs:0, urlProvider:() => state.configuredUrl, fetch,
    operations:{ [operation]:{ algorithmFingerprint:fingerprint, local:input => { state.localCalls++; return {value:input.value}; } } } });
  const request = (value = 1, extra = {}) => ({ operation, input:{value,payload:'x'.repeat(65536)}, binding:{scope:'test'},
    deadlineMs:1000, localReserveMs:0, ...extra });
  const released = async jobId => {
    const before = calls.length;
    await assert.rejects(bridge.getJobStatus(jobId), {code:'MEMORY_SUITE_COMPUTE_JOB_CONTEXT_MISSING'});
    assert.equal(calls.length, before, 'released context fails locally without another status request');
  };
  return { bridge,state,calls,jobs,cancellations,submitted,request,released };
}

for (const [fault, code] of [
  ['status_503','TEST_STATUS_UNAVAILABLE'], ['bad_digest','MEMORY_SUITE_COMPUTE_RESULT_DIGEST_MISMATCH'],
  ['foreign_status','MEMORY_SUITE_COMPUTE_JOB_INVALID'], ['binding','MEMORY_SUITE_COMPUTE_BINDING_STALE']
]) test(`${fault}: failure preserves its error, cancels only the accepted Job and releases repeated inputs`, async () => {
  const h = harness({fault});
  try {
    for (let i = 0; i < 3; i++) {
      await assert.rejects(h.bridge.prime(h.request(i,{validateBinding:() => fault !== 'binding'})),{code});
      await h.released(h.submitted[i]);
      assert.equal(h.cancellations[i].jobId,h.submitted[i]);
    }
    assert.equal(h.cancellations.length,3);
    assert.equal(h.bridge.status().backgroundJobs,0);
    assert.equal(h.bridge.status().derivedCacheEntries,0);
    h.bridge.clearDerivedCache();
    for (const jobId of h.submitted) await h.released(jobId);
  } finally { await h.bridge.dispose(); }
});

for (const cancelFault of ['503','invalid_json','hang','hang_body']) test(`cancel ${cancelFault}: cleanup is bounded and cannot mask the original error`, async () => {
  const h = harness({cancelFault});
  try {
    const start = Date.now();
    await assert.rejects(h.bridge.prime(h.request(1,{deadlineMs:10000})),{code:'TEST_STATUS_UNAVAILABLE'});
    assert.ok(Date.now()-start < 1500, 'cleanup must not wait for the original 10000ms Job budget or an unresponsive transport indefinitely');
    assert.equal(h.cancellations.length,1);
    await h.released(h.submitted[0]);
    assert.equal(h.bridge.status().backgroundJobs,0);
    await h.bridge.whenIdle();
    if (cancelFault.startsWith('hang')) assert.equal(h.cancellations[0].signal.aborted,true);
  } finally { await h.bridge.dispose(); }
});

test('a caller deadline also releases context when both cancellation attempts fail', async () => {
  const h = harness({fault:'timeout',cancelFault:'503'});
  try {
    await assert.rejects(h.bridge.prime(h.request(1,{deadlineMs:70})),{code:'MEMORY_SUITE_COMPUTE_TIMEOUT'});
    await h.released(h.submitted[0]); assert.equal(h.bridge.status().backgroundJobs,0);
  } finally { await h.bridge.dispose(); }
});

test('input context is released before a pending remote cancellation finishes', async()=>{
  const entered=deferred(),gate=deferred(),h=harness({onCancel:async()=>{entered.resolve();await gate.promise;}});
  try {
    const failure=h.bridge.prime(h.request());failure.catch(()=>{});
    await cleanupStarted(entered,failure);
    await h.released(h.submitted[0]);
    assert.equal(h.bridge.status().backgroundJobs,1,'only the bounded cleanup tail remains in flight');
    gate.resolve();await assert.rejects(failure,{code:'TEST_STATUS_UNAVAILABLE'});
    assert.equal(h.bridge.status().backgroundJobs,0);
  }finally{gate.resolve();await h.bridge.dispose();}
});

test('a submission failure before an accepted Job never invents a cancellation target', async()=>{
  const h=harness({fault:'submit_503'});
  try {
    await assert.rejects(h.bridge.prime(h.request()),{code:'TEST_SUBMIT_UNAVAILABLE'});
    assert.equal(h.submitted.length,0);assert.equal(h.cancellations.length,0);
    assert.equal(h.bridge.status().backgroundJobs,0);
  }finally{await h.bridge.dispose();}
});

test('dispose during a failed Job cleanup aborts its transport without reviving state', async()=>{
  const entered=deferred(),h=harness({cancelFault:'hang',onCancel:async()=>entered.resolve()});
  const failure=h.bridge.prime(h.request());failure.catch(()=>{});
  try {
    await cleanupStarted(entered,failure);
    await h.released(h.submitted[0]);
    await h.bridge.dispose();
    await assert.rejects(failure,{code:'TEST_STATUS_UNAVAILABLE'});
    assert.equal(h.cancellations[0].signal.aborted,true);
    assert.equal(h.bridge.status().disposed,true);assert.equal(h.bridge.status().state,'disposed');
    assert.equal(h.bridge.status().backgroundJobs,0);assert.equal(h.bridge.status().derivedCacheEntries,0);
  }finally{await h.bridge.dispose();}
});

test('coalesced callers observe the same error and the same input can subsequently retry and cache', async () => {
  const h = harness();
  try {
    const results = await Promise.allSettled([h.bridge.prime(h.request()),h.bridge.prime(h.request())]);
    assert(results.every(row => row.status === 'rejected' && row.reason.code === 'TEST_STATUS_UNAVAILABLE'));
    assert.equal(h.submitted.length,1); assert.equal(h.cancellations.length,1); await h.released(h.submitted[0]);
    h.state.fault = '';
    const retry = await h.bridge.prime(h.request()); assert.equal(retry.source,'server');
    assert.equal(h.submitted.length,2); assert.equal(h.cancellations.length,1); await h.released(h.submitted[1]);
    assert.equal((await h.bridge.prime(h.request())).source,'server_cache');
    assert.equal(h.submitted.length,2);
  } finally { await h.bridge.dispose(); }
});

test('executeCachedOrLocal keeps the local answer while its failed background work is released', async () => {
  const h = harness();
  try {
    for (let i=0;i<3;i++) {
      const result = await h.bridge.executeCachedOrLocal(h.request(i));
      assert.equal(result.source,'local'); assert.equal(result.result.value,i);
      await h.bridge.whenIdle(); await h.released(h.submitted[i]);
    }
    assert.equal(h.state.localCalls,3); assert.equal(h.cancellations.length,3);
    assert.equal(h.bridge.status().derivedCacheEntries,0);
  } finally { await h.bridge.dispose(); }
});

test('cleanup uses the accepted server even after a later connection switch', async () => {
  const h = harness();
  h.state.onStatus = async () => { h.state.onStatus = null; h.state.configuredUrl='http://127.0.0.1:47631'; await h.bridge.probe({force:true}); };
  try {
    await assert.rejects(h.bridge.prime(h.request()),{code:'TEST_STATUS_UNAVAILABLE'});
    assert.match(h.cancellations[0].url,/127\.0\.0\.1:47630\//);
    assert.equal(h.cancellations[0].authorization,'Bearer compute-only-1');
    assert.equal(h.state.bootstrapCount,2);
  } finally { await h.bridge.dispose(); }
});

test('a refreshed credential that accepted the submission is used for cleanup', async () => {
  const h = harness({rejectFirstSubmit:true});
  try {
    await assert.rejects(h.bridge.prime(h.request()),{code:'TEST_STATUS_UNAVAILABLE'});
    assert.equal(h.cancellations[0].authorization,'Bearer compute-only-2');
    assert.equal(h.state.bootstrapCount,2);
    await h.released(h.submitted[0]);
  } finally { await h.bridge.dispose(); }
});

test('one failed Job does not cancel or release another concurrent Job', async () => {
  const gate = deferred(), entered = deferred();
  const h = harness({fault:job => job.body.input.value === 1 ? 'status_503' : ''});
  h.state.onStatus = async job => { if(job.body.input.value === 2){entered.resolve();await gate.promise;} };
  try {
    const failed = h.bridge.prime(h.request(1)); failed.catch(()=>{});
    const healthy = h.bridge.prime(h.request(2)); healthy.catch(()=>{}); await entered.promise;
    await assert.rejects(failed,{code:'TEST_STATUS_UNAVAILABLE'});
    assert.equal(h.cancellations.length,1); assert.equal(h.jobs.get(h.cancellations[0].jobId).body.input.value,1);
    gate.resolve(); assert.equal((await healthy).result.value,2);
    assert.equal(h.bridge.status().backgroundJobs,0); assert.equal(h.bridge.status().derivedCacheEntries,1);
  } finally { gate.resolve(); await h.bridge.dispose(); }
});

test('explicit submitJob handles remain retryable after transient status failure', async () => {
  const h = harness();
  try {
    const job = await h.bridge.submitJob(h.request());
    await assert.rejects(h.bridge.getJobStatus(job),{code:'TEST_STATUS_UNAVAILABLE'});
    h.state.fault='';
    assert.equal((await h.bridge.waitForJob(job)).result.value,1);
    assert.equal(h.cancellations.length,0); await h.released(job.jobId);
  } finally { await h.bridge.dispose(); }
});

for(const fault of ['failed','cancelled','expired']) test(`terminal ${fault} is already released and does not need another cancel request`, async()=>{
  const h=harness({fault});
  try {
    await assert.rejects(h.bridge.prime(h.request()),{code:'MEMORY_SUITE_COMPUTE_JOB_FAILED'});
    await h.released(h.submitted[0]); assert.equal(h.cancellations.length,0);
  }finally{await h.bridge.dispose();}
});

test('a callback failure after verified adoption keeps the valid cache and sends no spurious cancel', async()=>{
  const h=harness({fault:''}); const error=new Error('callback-only');
  try {
    await assert.rejects(h.bridge.prime(h.request(1,{onDerivedResult:()=>{throw error;}})),candidate=>candidate===error);
    await h.released(h.submitted[0]); assert.equal(h.cancellations.length,0);
    assert.equal((await h.bridge.getDerivedResult(h.request())).source,'server_cache');
  }finally{await h.bridge.dispose();}
});
