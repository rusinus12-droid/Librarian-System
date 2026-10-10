'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const program = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(program, 'sdk', 'MemorySuiteComputeClient.source.js'), 'utf8');
const { createMemorySuiteComputeBridge } = new Function(`${source}\nreturn { createMemorySuiteComputeBridge };`)();

const canonicalize = value => {
  if (value === null || typeof value !== 'object') return JSON.stringify(Object.is(value, -0) ? 0 : value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
};
const digest = value => crypto.createHash('sha256').update(canonicalize(value)).digest('hex');
const response = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  async text() { return JSON.stringify(payload); }
});

const operation = 'test.background-rank.v1';
const fingerprint = 'test-background-rank-fingerprint-v1';
const jobs = new Map();
let bootstrapCalls = 0;
let submitCalls = 0;
let statusCalls = 0;
let resultCalls = 0;
let cancelCalls = 0;
let localCalls = 0;
let currentRevision = 1;

const publicJob = job => ({
  schema: 'memory-suite.compute.job.v1',
  jobId: job.jobId,
  namespace: job.body.namespace,
  operation: job.body.operation,
  operationId: job.body.operationId,
  algorithmFingerprint: job.body.algorithmFingerprint,
  inputDigest: job.body.inputDigest,
  binding: job.body.binding,
  lane: job.body.lane,
  state: job.state,
  createdAt: Date.now(),
  startedAt: job.state === 'queued' ? null : Date.now(),
  completedAt: ['succeeded', 'cancelled'].includes(job.state) ? Date.now() : null,
  deadlineMs: job.body.deadlineMs,
  ...(job.state === 'cancelled' ? { error: 'compute_job_cancelled', code: 'COMPUTE_JOB_CANCELLED' } : {})
});
const publicResult = job => {
  const result = { ranked: [...job.body.input.values].sort((left, right) => right - left) };
  return {
    schema: 'memory-suite.compute.result.v1',
    jobId: job.jobId,
    operationId: job.body.operationId,
    namespace: job.body.namespace,
    operation: job.body.operation,
    algorithmFingerprint: job.body.algorithmFingerprint,
    inputDigest: job.body.inputDigest,
    binding: job.body.binding,
    result,
    resultDigest: digest(result),
    timing: { queueMs: 1, workerMs: 2, totalMs: 3 }
  };
};

const fetchImpl = async (url, init = {}) => {
  const target = String(url);
  assert.equal(init.headers?.['X-Memory-Suite-Compute-Pairing'], undefined, 'background Compute never sends a pairing key');
  if (target.endsWith('/v1/compute/bootstrap')) {
    bootstrapCalls += 1;
    assert.equal(init.headers.Authorization, undefined, 'Compute bootstrap never reuses a Storage token');
    return response({
      ok: true,
      schema: 'memory-suite.compute.bootstrap.v1',
      version: '0.3.2-test',
      url: 'http://127.0.0.1:47630',
      token: 'compute-only-token',
      authorization: { pluginId: 'test_plugin', namespace: 'test', roles: ['compute'] },
      capabilities: { 'compute.v1': true, 'compute-jobs.v1': true },
      limits: { maxDeadlineMs: 30000 },
      operations: [{ operation, algorithmFingerprint: fingerprint, maxDeadlineMs: 30000 }]
    });
  }
  assert.equal(init.headers.Authorization, 'Bearer compute-only-token');
  if (target.endsWith('/v1/compute/jobs') && init.method === 'POST') {
    submitCalls += 1;
    const body = JSON.parse(init.body);
    const jobId = `cmp_background_${submitCalls}`;
    const job = { jobId, body, state: 'queued', polls: 0 };
    jobs.set(jobId, job);
    return response({ ok: true, schema: 'memory-suite.compute.job-response.v1', result: publicJob(job) }, 202);
  }
  const match = target.match(/\/v1\/compute\/jobs\/([^/]+)(?:\/(result|cancel))?$/);
  if (!match) throw new Error(`unexpected_url:${target}`);
  const job = jobs.get(decodeURIComponent(match[1]));
  assert.ok(job, 'job exists');
  if (match[2] === 'cancel') {
    cancelCalls += 1;
    job.state = 'cancelled';
    return response({ ok: true, schema: 'memory-suite.compute.cancel-response.v1', result: { ...publicJob(job), cancelAccepted: true } });
  }
  if (match[2] === 'result') {
    resultCalls += 1;
    assert.equal(job.state, 'succeeded');
    return response({ ok: true, schema: 'memory-suite.compute.result-response.v1', result: publicResult(job) });
  }
  statusCalls += 1;
  job.polls += 1;
  if (job.polls >= 2) job.state = 'succeeded';
  else job.state = 'running';
  return response({ ok: true, schema: 'memory-suite.compute.job-response.v1', result: publicJob(job) });
};

let mode = 'local';
const bridge = createMemorySuiteComputeBridge({
  namespace: 'test',
  pluginId: 'test_plugin',
  pluginVersion: '1.0.0',
  fetch: fetchImpl,
  urlProvider: async () => 'http://127.0.0.1:47630',
  modeProvider: async () => mode,
  modeSetter: async value => { mode = value; return true; },
  backgroundProbe: false,
  defaultDeadlineMs: 3000,
  localReserveMs: 0,
  jobPollIntervalMs: 25,
  operations: {
    [operation]: {
      algorithmFingerprint: fingerprint,
      local: async input => {
        localCalls += 1;
        return { ranked: [...input.values].sort((left, right) => right - left) };
      },
      validateResult: (result, context) => Array.isArray(result?.ranked)
        && result.ranked.length === context.input.values.length
    }
  }
});

async function main() {
  const request = () => ({
    operation,
    input: { values: [1, 9, 4] },
    binding: { revision: currentRevision },
    lane: 'background',
    deadlineMs: 3000,
    localReserveMs: 0,
    validateBinding: binding => binding.revision === currentRevision
  });

  const local = await bridge.executeCachedOrLocal(request());
  assert.equal(local.source, 'local');
  assert.equal(localCalls, 1);
  assert.deepEqual({ bootstrapCalls, submitCalls }, { bootstrapCalls: 0, submitCalls: 0 }, 'local mode is a strict zero-network boundary');

  await bridge.setMode('prefer_server');
  const first = await bridge.executeCachedOrLocal(request());
  assert.equal(first.source, 'local', 'a cold background cache never blocks the owner path');
  assert.equal(first.fallbackReason, 'MEMORY_SUITE_COMPUTE_CACHE_MISS');
  assert.equal(localCalls, 2);
  await bridge.whenIdle();
  assert.equal(submitCalls, 1);
  assert.ok(statusCalls >= 2);
  assert.equal(resultCalls, 1);

  const cached = await bridge.executeCachedOrLocal(request());
  assert.equal(cached.source, 'server_cache', 'a verified completed job is adopted on the next matching owner snapshot');
  assert.deepEqual(cached.result.ranked, [9, 4, 1]);
  assert.equal(localCalls, 2, 'cache hit avoids duplicate local CPU work in prefer-server mode');

  currentRevision = 2;
  const revised = await bridge.executeCachedOrLocal(request());
  assert.equal(revised.source, 'local', 'a new owner binding cannot adopt the previous cache entry');
  assert.equal(localCalls, 3);
  await bridge.whenIdle();
  const revisedCached = await bridge.executeCachedOrLocal(request());
  assert.equal(revisedCached.source, 'server_cache');
  assert.equal(submitCalls, 2);

  const submitted = await bridge.submitJob({ ...request(), input: { values: [7, 2] }, operationId: 'test.background.cancel.0001' });
  assert.equal(submitted.state, 'queued');
  const cancelled = await bridge.cancelJob(submitted);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.cancelAccepted, true);
  assert.equal(cancelCalls, 1);

  const disposeOwned = await bridge.submitJob({ ...request(), input: { values: [8, 3] }, operationId: 'test.background.dispose.0001' });
  assert.equal(disposeOwned.state, 'queued');

  const status = bridge.status();
  assert.equal(status.counters.jobsSucceeded, 2);
  assert.equal(status.derivedCacheEntries, 2);
  assert.ok(status.counters.cacheHits >= 2);
  await bridge.dispose();
  assert.equal(cancelCalls, 2, 'dispose best-effort cancels an outstanding server Job without user input');
  process.stdout.write('compute_background_job_cache_test: PASS\n');
}

main().catch(error => {
  process.stderr.write(`compute_background_job_cache_test: FAIL\n${error.stack || error}\n`);
  process.exitCode = 1;
});
