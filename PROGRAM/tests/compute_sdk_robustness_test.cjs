'use strict';
// Compute SDK robustness regressions (0.3.8): owner-callback deadlines, half-open
// circuit recovery, Job context release, accepted-connection follow-up, orphan
// server Jobs, mode/cache generations, background Job limit, coalesced callbacks,
// LRU eviction, dispose state, poll timers, oversized responses and shared
// bootstrap/refresh. Observed only through the public bridge API and a fake transport.
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
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const never = () => new Promise(() => {});
// Settles `promise` or reports that it is still pending after `ms` (so a regression cannot hang the suite).
const within = (promise, ms) => Promise.race([
  Promise.resolve(promise).then(value => ({ settled:true, value }), error => ({ settled:true, error })),
  sleep(ms).then(() => ({ settled:false }))
]);
const operation = 'test.robustness.v1', fingerprint = 'robustness-v1';
const BASE = 'http://127.0.0.1:47630', OTHER = 'http://127.0.0.1:47631';

function harness(over = {}, bridgeOptions = {}) {
  const jobs = new Map(), calls = [], cancels = [], submitted = [];
  const st = { url:BASE, boot:0, bootDelay:0, executeFail:false, rejectToken:'', executeDelay:0, executeResult:null,
    statusFault:'', statusState:'succeeded', statusJobId:'', resultFault:'', cancelState:'cancelled', submitDelay:null,
    local:0, ...over };
  const publicJob = (job, jobState) => ({ schema:'memory-suite.compute.job.v1', jobId:job.jobId, namespace:'test', operation,
    operationId:job.body.operationId, algorithmFingerprint:fingerprint, inputDigest:job.body.inputDigest, binding:job.body.binding, state:jobState });
  const fetch = async (url, init = {}) => {
    calls.push({ url, method:init.method, auth:init.headers?.Authorization });
    if (url.endsWith('/bootstrap')) {
      st.boot++;
      const token = `tok-${st.boot}`;
      if (st.bootDelay) await sleep(st.bootDelay);
      return response({ ok:true, schema:'memory-suite.compute.bootstrap.v1', version:'t', url:new URL(url).origin, token,
        authorization:{ pluginId:'robust', namespace:'test', roles:['compute'] }, capabilities:{ 'compute.v1':true },
        limits:{ maxDeadlineMs:120000 }, operations:[{ operation, algorithmFingerprint:fingerprint, maxDeadlineMs:120000 }] });
    }
    if (url.endsWith('/execute')) {
      if (st.executeDelay) await sleep(st.executeDelay);
      if (st.rejectToken && init.headers.Authorization === `Bearer ${st.rejectToken}`) return response({ ok:false, error:'rotated', code:'T_AUTH' }, 403);
      if (st.executeFail) return response({ ok:false, error:'boom', code:'T500' }, 500);
      if (st.executeResult) return st.executeResult(JSON.parse(init.body));
      const body = JSON.parse(init.body), result = { value:body.input.value };
      return response({ ok:true, schema:'memory-suite.compute.execute-response.v1', result:{ schema:'memory-suite.compute.result.v1',
        operationId:body.operationId, namespace:'test', operation, algorithmFingerprint:fingerprint, inputDigest:body.inputDigest,
        binding:body.binding, result, resultDigest:digest(result) } });
    }
    if (url.endsWith('/jobs')) {
      const job = { jobId:`robust_job_${jobs.size + 1}`, body:JSON.parse(init.body) };
      jobs.set(job.jobId, job); submitted.push(job.jobId);
      if (st.submitDelay) await st.submitDelay(job);
      return response({ ok:true, schema:'memory-suite.compute.job-response.v1', result:publicJob(job, 'queued') }, 202);
    }
    const match = url.match(/\/jobs\/([^/]+)(?:\/(result|cancel))?$/);
    assert.ok(match, url);
    const job = jobs.get(decodeURIComponent(match[1]));
    if (match[2] === 'cancel') {
      cancels.push({ jobId:job.jobId, url, auth:init.headers.Authorization });
      return response({ ok:true, schema:'memory-suite.compute.cancel-response.v1', result:{ ...publicJob(job, st.cancelState), cancelAccepted:true } });
    }
    if (match[2] === 'result') {
      const result = { value:job.body.input.value };
      return response({ ok:true, schema:'memory-suite.compute.result-response.v1', result:{ ...publicJob(job, 'succeeded'),
        schema:'memory-suite.compute.result.v1', result, resultDigest:st.resultFault === 'bad_digest' ? '0'.repeat(64) : digest(result) } });
    }
    if (st.statusFault === '503') return response({ ok:false, error:'unavailable', code:'T503' }, 503);
    if (st.statusFault === '404') return response({ ok:false, error:'compute_job_not_found', code:'T404' }, 404);
    const jobState = typeof st.statusState === 'function' ? st.statusState(job) : st.statusState;
    return response({ ok:true, schema:'memory-suite.compute.job-response.v1', result:{ ...publicJob(job, jobState), ...(st.statusJobId ? { jobId:st.statusJobId } : {}) } });
  };
  const bridge = create({ namespace:'test', pluginId:'robust', defaultMode:'prefer_server', backgroundProbe:false,
    disposeCancelGraceMs:0, urlProvider:() => st.url, fetch,
    operations:{ [operation]:{ algorithmFingerprint:fingerprint, local:input => { st.local++; return { value:input.value }; } } },
    ...bridgeOptions });
  const request = (value = 1, extra = {}) => ({ operation, input:{ value }, binding:{ scope:'a' }, deadlineMs:1000, localReserveMs:0, ...extra });
  const released = async jobId => {
    const before = calls.length;
    await assert.rejects(bridge.getJobStatus(jobId), { code:'MEMORY_SUITE_COMPUTE_JOB_CONTEXT_MISSING' });
    assert.equal(calls.length, before, 'a released context fails locally without another request');
  };
  return { bridge, st, calls, cancels, submitted, jobs, request, released };
}
const executeRequest = extra => ({ operation, input:{ value:1 }, binding:{ s:1 }, deadlineMs:300, localReserveMs:100, mode:'prefer_server', ...extra });

// C1
test('a hung owner callback during a half-open attempt does not pin the circuit', async () => {
  let clock = Date.now();
  const h = harness({ executeFail:true }, { now:() => clock });
  try {
    const failing = executeRequest({ deadlineMs:500, localReserveMs:50 });
    await h.bridge.execute(failing); await h.bridge.execute(failing);
    assert.equal(h.bridge.status().circuit.state, 'open');
    clock += 6000; h.st.executeFail = false;
    h.bridge.execute(executeRequest({ deadlineMs:500, localReserveMs:50, validateBinding:never })).catch(() => {});
    await sleep(20);
    const sources = [];
    for (let i = 0; i < 3; i++) { clock += 120000; sources.push((await h.bridge.execute(executeRequest({ deadlineMs:500, localReserveMs:50 }))).source); }
    assert.equal(sources.at(-1), 'server', `server must be used again after the stale half-open lease (${sources})`);
    assert.equal(h.bridge.status().circuit.halfOpenInFlight, false);
    assert.equal((await h.bridge.probe({ force:true })).ok, true);
  } finally { await h.bridge.dispose(); }
});

// C2
test('execute deadline bounds validateBinding, validateResult, mode reads and the binding provider', async () => {
  let h = harness();
  try {
    const hung = await within(h.bridge.execute(executeRequest({ validateBinding:never })), 1500);
    assert.equal(hung.settled, true, 'hung validateBinding must not hang execute'); assert.equal(hung.value.source, 'local');
    const start = Date.now();
    const slow = await h.bridge.execute(executeRequest({ validateBinding:async () => { await sleep(1000); return true; } }));
    assert.equal(slow.source, 'local'); assert.ok(Date.now() - start < 700, `slow validator exceeded the deadline (${Date.now() - start}ms)`);
  } finally { await h.bridge.dispose(); }
  h = harness({}, { operations:{ [operation]:{ algorithmFingerprint:fingerprint, local:input => ({ value:input.value }), validateResult:never } } });
  try {
    const outcome = await within(h.bridge.execute(executeRequest()), 1500);
    assert.equal(outcome.settled, true, 'hung validateResult must not hang execute');
  } finally { await h.bridge.dispose(); }
  h = harness({}, { urlProvider:undefined, getArgument:never, defaultUrl:BASE });
  try {
    const outcome = await within(h.bridge.execute(executeRequest({ mode:undefined })), 1500);
    assert.equal(outcome.settled, true, 'hung mode read must not hang execute'); assert.equal(outcome.value.source, 'local');
  } finally { await h.bridge.dispose(); }
  h = harness({}, { bindingProvider:never });
  try {
    const outcome = await within(h.bridge.execute(executeRequest({ binding:undefined })), 1500);
    assert.equal(outcome.settled, true, 'hung binding provider must not hang execute'); assert.equal(outcome.value.source, 'local');
  } finally { await h.bridge.dispose(); }
});

// C3
for (const [name, over] of [['status 503', { statusFault:'503' }], ['status 404 after server restart', { statusFault:'404' }],
  ['bad result digest', { resultFault:'bad_digest' }], ['deadline with cancel still running', { statusState:'running', cancelState:'running' }]]) {
  test(`waitForJob releases the Job context on ${name}`, async () => {
    const h = harness(over);
    try {
      const job = await h.bridge.submitJob(h.request(1, { deadlineMs:300 }));
      await assert.rejects(h.bridge.waitForJob(job));
      await h.released(job.jobId);
    } finally { await h.bridge.dispose(); }
  });
}
test('never-waited Job contexts past deadline plus grace are pruned on the next submit', async () => {
  let clock = Date.now();
  const h = harness({}, { now:() => clock });
  try {
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push((await h.bridge.submitJob(h.request(i, { deadlineMs:100 }))).jobId);
    clock += 10 * 60 * 1000;
    const fresh = await h.bridge.submitJob(h.request(99, { deadlineMs:5000 }));
    for (const id of ids) await h.released(id);
    assert.equal((await h.bridge.getJobStatus(fresh)).jobId, fresh.jobId);
  } finally { await h.bridge.dispose(); }
});
test('a status response for a different jobId is rejected', async () => {
  const h = harness({ statusJobId:'some_other_job_id' });
  try {
    const job = await h.bridge.submitJob(h.request());
    await assert.rejects(h.bridge.getJobStatus(job), { code:'MEMORY_SUITE_COMPUTE_JOB_INVALID' });
  } finally { await h.bridge.dispose(); }
});

// C4
test('dispose cancels on the accepting server without bootstrapping or following a URL change', async () => {
  let clock = Date.now();
  const h = harness({ statusState:'running' }, { disposeCancelGraceMs:500, now:() => clock });
  const job = await h.bridge.submitJob(h.request(1, { deadlineMs:60000 }));
  clock += 31000; h.st.url = OTHER;
  const before = h.calls.length, boots = h.st.boot;
  await h.bridge.dispose();
  assert.equal(h.st.boot, boots, 'no bootstrap during dispose');
  assert.deepEqual(h.calls.slice(before).map(call => call.url), [`${BASE}/v1/compute/jobs/${job.jobId}/cancel`]);
});
test('status of an accepted Job uses the accepting connection after cache expiry and URL change', async () => {
  let clock = Date.now();
  const h = harness({ statusState:'running' }, { now:() => clock });
  try {
    const job = await h.bridge.submitJob(h.request(1, { deadlineMs:60000 }));
    clock += 31000; h.st.url = OTHER;
    const before = h.calls.length, boots = h.st.boot;
    assert.equal((await h.bridge.getJobStatus(job)).state, 'running');
    assert.equal(h.st.boot, boots);
    assert.match(h.calls[before].url, /127\.0\.0\.1:47630\//);
  } finally { await h.bridge.dispose(); }
});

// C5
test('dispose while a submission is in flight cancels the Job the server accepted', async () => {
  let release = null;
  const h = harness({ submitDelay:() => new Promise(resolve => { release = resolve; }) });
  const primed = h.bridge.prime(h.request(1, { deadlineMs:5000 })); primed.catch(() => {});
  while (!release) await sleep(5);
  const disposed = h.bridge.dispose(); release(); await disposed;
  await assert.rejects(primed, { code:'MEMORY_SUITE_COMPUTE_BRIDGE_DISPOSED' });
  await sleep(50);
  assert.deepEqual(h.cancels.map(row => row.jobId), h.submitted);
  assert.match(h.cancels[0].url, /127\.0\.0\.1:47630\//);
});
test('a submission accepted after the client timed out is cancelled', async () => {
  const h = harness({ submitDelay:() => sleep(300) });
  try {
    await assert.rejects(h.bridge.prime(h.request(1, { deadlineMs:150 })), { code:'MEMORY_SUITE_COMPUTE_TIMEOUT' });
    await sleep(300);
    assert.equal(h.submitted.length, 1);
    assert.deepEqual(h.cancels.map(row => row.jobId), h.submitted);
  } finally { await h.bridge.dispose(); }
});
test('no Job is submitted or left running when work is requested during the dispose grace window', async () => {
  const h = harness({ statusState:'running' }, { disposeCancelGraceMs:200 });
  await h.bridge.submitJob(h.request(1, { deadlineMs:5000 }));
  const primed = h.bridge.prime(h.request(2, { deadlineMs:5000 })); primed.catch(() => {});
  await h.bridge.dispose(); await sleep(50);
  await assert.rejects(primed, { code:'MEMORY_SUITE_COMPUTE_BRIDGE_DISPOSED' });
  const cancelled = new Set(h.cancels.map(row => row.jobId));
  for (const jobId of h.submitted) assert.ok(cancelled.has(jobId), `${jobId} accepted but never cancelled`);
});

// C6, C7
test("setMode('local') stops in-flight background Jobs without bootstrapping or caching", async () => {
  let polls = 0, mode = 'prefer_server';
  const h = harness({ statusState:() => (++polls < 6 ? 'running' : 'succeeded') },
    { modeProvider:() => mode, modeSetter:value => { mode = value; return true; }, jobPollIntervalMs:25 });
  try {
    const primed = h.bridge.prime(h.request(1, { deadlineMs:3000, mode:'prefer_server' }));
    await sleep(40);
    await h.bridge.setMode('local');
    const boots = h.st.boot, calls = h.calls.length;
    const outcome = await within(primed, 2000);
    assert.equal(outcome.settled, true);
    assert.notEqual(outcome.value?.source, 'server', 'a Job from the previous mode must not be adopted');
    assert.equal(h.st.boot, boots, 'no re-bootstrap after switching to local');
    assert.ok(h.calls.length - calls <= 2, `background polling continued (${h.calls.length - calls} requests)`);
    assert.equal(h.bridge.status().derivedCacheEntries, 0);
  } finally { await h.bridge.dispose(); }
});
test('clearDerivedCache during an in-flight Job is not undone when the Job completes', async () => {
  let polls = 0;
  const h = harness({ statusState:() => (++polls < 4 ? 'running' : 'succeeded') }, { jobPollIntervalMs:25 });
  try {
    const primed = h.bridge.prime(h.request(7, { deadlineMs:3000 }));
    await sleep(30); h.bridge.clearDerivedCache();
    assert.equal((await primed).source, 'server');
    assert.equal(h.bridge.status().derivedCacheEntries, 0);
    assert.equal(await h.bridge.getDerivedResult(h.request(7)), null);
  } finally { await h.bridge.dispose(); }
});

// C8
test('concurrent background Jobs are capped and the local answer is still returned', async () => {
  const h = harness({ statusState:'running' });
  try {
    for (let i = 0; i < 20; i++) assert.equal((await h.bridge.executeCachedOrLocal(h.request(i, { deadlineMs:5000 }))).source, 'local');
    assert.ok(h.bridge.status().backgroundJobs <= 6, `backgroundJobs=${h.bridge.status().backgroundJobs}`);
    assert.ok(h.submitted.length <= 6, `submitted=${h.submitted.length}`);
    const skipped = await h.bridge.prime(h.request(100, { deadlineMs:5000 }));
    assert.equal(skipped.skipped, true); assert.equal(skipped.reason, 'background_job_limit');
  } finally { await h.bridge.dispose(); }
});

// C9, C10
test('every coalesced prime() caller receives its own derived-result callback', async () => {
  const h = harness(), hits = [];
  try {
    await Promise.all([h.bridge.prime(h.request(1, { onDerivedResult:() => hits.push('A') })), h.bridge.prime(h.request(1, { onDerivedResult:() => hits.push('B') }))]);
    assert.deepEqual(hits.sort(), ['A', 'B']); assert.equal(h.submitted.length, 1);
  } finally { await h.bridge.dispose(); }
});
test('derived cache eviction is least-recently-used', async () => {
  let clock = Date.now();
  const h = harness({}, { maxDerivedCacheEntries:2, now:() => clock });
  try {
    await h.bridge.prime(h.request(1)); clock += 10; await h.bridge.prime(h.request(2)); clock += 10;
    await h.bridge.getDerivedResult(h.request(1)); clock += 10;
    await h.bridge.prime(h.request(3));
    assert.equal((await h.bridge.getDerivedResult(h.request(1)))?.source, 'server_cache', 'recently used entry kept');
    assert.equal(await h.bridge.getDerivedResult(h.request(2)), null, 'least recently used entry evicted');
  } finally { await h.bridge.dispose(); }
});

// C11, C12, C13
test('dispose aborting an in-flight probe keeps the disposed status and circuit', async () => {
  const bridge = create({ namespace:'test', pluginId:'robust', backgroundProbe:false, defaultMode:'prefer_server', urlProvider:() => BASE,
    fetch:(url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name:'AbortError' })))),
    operations:{ [operation]:{ algorithmFingerprint:fingerprint, local:input => input } } });
  const probing = bridge.probe(); await sleep(10); await bridge.dispose(); await probing;
  assert.equal(bridge.status().state, 'disposed'); assert.equal(bridge.status().circuit.failures, 0);
});
test('concurrent dispose() calls run the shutdown once', async () => {
  const h = harness({ statusState:'running' }, { disposeCancelGraceMs:200 });
  await h.bridge.submitJob(h.request(1, { deadlineMs:5000 }));
  assert.deepEqual(await Promise.all([h.bridge.dispose(), h.bridge.dispose()]), [true, false]);
  assert.equal(h.cancels.length, 1);
});
test('dispose wakes a background poll sleep immediately', async () => {
  const h = harness({ statusState:'running' }, { jobPollIntervalMs:2000 });
  const primed = h.bridge.prime(h.request(1, { deadlineMs:60000 })); primed.catch(() => {});
  await sleep(100);
  const start = Date.now(); await h.bridge.dispose();
  const outcome = await within(primed, 1500);
  assert.equal(outcome.settled, true); assert.equal(outcome.error?.code, 'MEMORY_SUITE_COMPUTE_BRIDGE_DISPOSED');
  assert.ok(Date.now() - start < 500, `poll sleep outlived dispose by ${Date.now() - start}ms`);
});

// C14
test('an oversized server response is rejected as RESULT_INVALID before parsing', async () => {
  const big = 'x'.repeat(2 * 1024 * 1024);
  let h = harness({ executeResult:() => ({ ok:true, status:200, text:async () => JSON.stringify({ ok:true, schema:'memory-suite.compute.execute-response.v1', result:{ big } }) }) },
    { maxResultBytes:1024 });
  try {
    const result = await h.bridge.execute(executeRequest({ deadlineMs:5000 }));
    assert.equal(result.source, 'local'); assert.equal(result.fallbackReason, 'MEMORY_SUITE_COMPUTE_RESULT_INVALID');
  } finally { await h.bridge.dispose(); }
  let textCalls = 0;
  h = harness({ executeResult:() => ({ ok:true, status:200, headers:{ get:name => (name === 'content-length' ? String(64 * 1024 * 1024) : null) },
    text:async () => { textCalls++; return '{}'; } }) }, { maxResultBytes:1024 });
  try {
    const result = await h.bridge.execute(executeRequest({ deadlineMs:5000 }));
    assert.equal(result.fallbackReason, 'MEMORY_SUITE_COMPUTE_RESULT_INVALID'); assert.equal(textCalls, 0, 'body must not be read');
  } finally { await h.bridge.dispose(); }
});

// S1
test('a short-budget caller timing out does not discard a shared bootstrap', async () => {
  // The short caller starts the bootstrap (slow URL resolution + slow bootstrap) and gives up
  // first; a longer caller joined to the same bootstrap still adopts it, and it stays cached.
  let urlProvider = () => BASE;
  const h = harness({ bootDelay:100 }, { urlProvider:() => urlProvider() });
  try {
    urlProvider = async () => { await sleep(100); return BASE; };
    const short = h.bridge.execute(executeRequest({ deadlineMs:200, localReserveMs:50 }));
    await sleep(10);
    const joined = h.bridge.execute(executeRequest({ deadlineMs:3000, localReserveMs:50 }));
    assert.equal((await short).source, 'local');
    assert.equal((await joined).source, 'server');
    urlProvider = () => BASE;
    assert.equal((await h.bridge.execute(executeRequest({ deadlineMs:3000, localReserveMs:50 }))).source, 'server');
    assert.equal(h.st.boot, 1, 'the shared bootstrap is reused instead of repeated');
  } finally { await h.bridge.dispose(); }
});
test('concurrent 401/403 responses share one credential refresh', async () => {
  const h = harness({ rejectToken:'tok-1', executeDelay:20 });
  try {
    const results = await Promise.all([1, 2, 3].map(() => h.bridge.execute(executeRequest({ deadlineMs:3000, localReserveMs:50 }))));
    assert.deepEqual(results.map(row => row.source), ['server', 'server', 'server']);
    assert.equal(h.st.boot, 2, 'one initial bootstrap plus one shared refresh');
  } finally { await h.bridge.dispose(); }
});
