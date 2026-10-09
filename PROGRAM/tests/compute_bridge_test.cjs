'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const program = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(program, 'sdk', 'MemorySuiteComputeClient.source.js'), 'utf8');

assert.equal((source.match(/const createMemorySuiteComputeBridge/g) || []).length, 1, 'one compute factory source block');
assert.match(source, /const MODE_LOCAL = 'local'/);
assert.match(source, /const MODE_PREFER_SERVER = 'prefer_server'/);
assert.doesNotMatch(source, /const MODE_SHADOW = 'shadow'|shadowMatches|shadowMismatches|onShadowComparison/);
assert.doesNotMatch(source, /remote_only/);
assert.doesNotMatch(source, /X-Memory-Suite-Compute-Pairing|pairingProvider|storageBridge\.bootstrap/);
assert.match(source, /const resolveServerUrl = async/);
assert.match(source, /MEMORY_SUITE_COMPUTE_RESULT_DIGEST_MISMATCH/);
assert.match(source, /MEMORY_SUITE_COMPUTE_BINDING_STALE/);
assert.match(source, /lifecycle\.abortControllers/);
assert.match(source, /executeCachedOrLocal/);
assert.match(source, /submitJob/);
assert.match(source, /getJobResult/);

const context = {
  console: { warn() {}, log() {}, error() {} },
  URL,
  AbortController,
  TextEncoder,
  Uint8Array,
  Uint32Array,
  setTimeout,
  clearTimeout,
  Promise,
  Map,
  Set,
  WeakMap,
  Object,
  Array,
  JSON,
  Date,
  Math,
  String,
  Number,
  Boolean
};
context.globalThis = context;
vm.runInNewContext(`${source}\n;globalThis.__factory = createMemorySuiteComputeBridge;`, context, { timeout: 5000 });
const createBridge = context.__factory;

const canonicalize = value => {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('non_finite');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
};
const digest = value => crypto.createHash('sha256').update(canonicalize(value)).digest('hex');
const response = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(payload)
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const computeBootstrap = (operation = 'test.rank.v1', fingerprint = 'test-kernel-v1') => ({
  ok: true,
  schema: 'memory-suite.compute.bootstrap.v1',
  name: 'Librarian System Compute',
  version: '0.3.2-test',
  url: 'http://127.0.0.1:47630',
  token: 'compute-token',
  authorization: {
    schema: 'memory-suite.compute-authorization.v1',
    pluginId: 'test_plugin',
    namespace: 'test',
    roles: ['compute']
  },
  capabilities: { 'compute.v1': true, 'compute-jobs.v1': true, 'compute-worker-pool.v1': true },
  limits: { maxDeadlineMs: 5000 },
  operations: [{ operation, algorithmFingerprint: fingerprint, maxDeadlineMs: 5000 }]
});

const executePayload = (body, result, overrides = {}) => ({
  ok: true,
  schema: 'memory-suite.compute.execute-response.v1',
  result: {
    schema: 'memory-suite.compute.result.v1',
    jobId: `job-${body.operationId}`,
    operationId: body.operationId,
    namespace: body.namespace,
    operation: body.operation,
    algorithmFingerprint: body.algorithmFingerprint,
    inputDigest: body.inputDigest,
    binding: body.binding,
    result,
    resultDigest: digest(result),
    timing: { workerMs: 3 },
    ...overrides
  }
});

const makeHarness = (overrides = {}) => {
  let mode = overrides.mode || 'local';
  let localCalls = 0;
  let computeBootstrapCalls = 0;
  let executeCalls = 0;
  const operation = overrides.operation || 'test.rank.v1';
  const fingerprint = overrides.fingerprint || 'test-kernel-v1';
  const local = overrides.local || (async input => ({ ranked: [...input.values].sort((a, b) => b - a) }));
  const fetchImpl = overrides.fetch || (async (url, init = {}) => {
    if (String(url).endsWith('/v1/compute/bootstrap')) {
      computeBootstrapCalls += 1;
      assert.equal(init.headers['X-Memory-Suite-Compute-Pairing'], undefined);
      assert.equal(init.headers.Authorization, undefined, 'storage bearer token is never reused for compute bootstrap');
      return response(computeBootstrap(operation, fingerprint));
    }
    if (String(url).endsWith('/v1/compute/execute')) {
      executeCalls += 1;
      assert.equal(init.headers.Authorization, 'Bearer compute-token');
      const body = JSON.parse(init.body);
      const result = overrides.serverResult ? await overrides.serverResult(body, init) : { ranked: [...body.input.values].sort((a, b) => b - a) };
      return response(executePayload(body, result, overrides.executeResultOverrides?.(body, result) || {}));
    }
    throw new Error(`unexpected_url:${url}`);
  });
  const bindingProvider = overrides.bindingProvider;
  const bridge = createBridge({
    namespace: 'test',
    pluginId: 'test_plugin',
    pluginVersion: '1.0.0',
    urlProvider: async () => 'http://127.0.0.1:47630',
    operations: {
      [operation]: {
        algorithmFingerprint: fingerprint,
        local: async (input, callContext) => {
          localCalls += 1;
          return await local(input, callContext);
        },
        ...(overrides.descriptor || {})
      }
    },
    fetch: fetchImpl,
    modeProvider: async () => mode,
    modeSetter: async value => { mode = value; return true; },
    ...(bindingProvider ? { bindingProvider } : {}),
    ...(overrides.validateBinding ? { validateBinding: overrides.validateBinding } : {}),
    backgroundProbe: overrides.backgroundProbe === true,
    backgroundProbeDelayMs: overrides.backgroundProbeDelayMs ?? 0,
    defaultDeadlineMs: overrides.defaultDeadlineMs || 400,
    localReserveMs: overrides.localReserveMs ?? 100,
    probeTimeoutMs: overrides.probeTimeoutMs || 200,
    circuitFailureThreshold: overrides.circuitFailureThreshold || 2,
    circuitBaseCooldownMs: overrides.circuitBaseCooldownMs || 250,
    circuitMaxCooldownMs: overrides.circuitMaxCooldownMs || 1000,
    ...(overrides.now ? { now: overrides.now } : {})
  });
  return {
    bridge,
    operation,
    fingerprint,
    setMode(value) { mode = value; },
    counts: () => ({ localCalls, computeBootstrapCalls, executeCalls })
  };
};

(async () => {
  {
    const harness = makeHarness({ mode: 'local', backgroundProbe: true });
    await delay(25);
    const result = await harness.bridge.execute({ operation: harness.operation, input: { values: [1, 3, 2] }, binding: { revision: 1 } });
    assert.equal(result.source, 'local');
    assert.deepEqual(result.result.ranked, [3, 2, 1]);
    assert.equal(result.inputDigest, digest({ values: [1, 3, 2] }), 'client canonical SHA-256 matches the server contract');
    assert.equal(result.resultDigest, digest({ ranked: [3, 2, 1] }));
    assert.deepEqual(harness.counts(), { localCalls: 1, computeBootstrapCalls: 0, executeCalls: 0 }, 'local mode performs zero network probes');
    await harness.bridge.dispose();
  }

  {
    let directBootstrapCalls = 0;
    const harness = makeHarness({
      mode: 'prefer_server',
      fetch: async url => {
        assert.match(String(url), /\/v1\/compute\/bootstrap$/);
        directBootstrapCalls += 1;
        return response({ ok: false, error: 'compute_route_missing', code: 'COMPUTE_UNSUPPORTED' }, 404);
      }
    });
    const result = await harness.bridge.execute({ operation: harness.operation, input: { values: [2, 1] }, binding: { revision: 1 } });
    assert.equal(result.source, 'local');
    assert.equal(result.fallbackReason, 'COMPUTE_UNSUPPORTED');
    assert.equal(directBootstrapCalls, 1, 'Compute contacts its own bootstrap directly');
    assert.deepEqual(harness.counts(), { localCalls: 1, computeBootstrapCalls: 0, executeCalls: 0 }, 'a server without Compute falls back locally without Storage bootstrap');
    await harness.bridge.dispose();
  }

  {
    let binding = { scopeId: 'scope:a', revision: 7, sourceDigest: 'source-a' };
    const harness = makeHarness({ mode: 'prefer_server', bindingProvider: async () => binding });
    const result = await harness.bridge.execute({ operation: harness.operation, input: { values: [4, 1, 9] } });
    assert.equal(result.source, 'server');
    assert.deepEqual(result.result.ranked, [9, 4, 1]);
    assert.equal(result.bindingValidation, 'provider_readback');
    assert.deepEqual(harness.counts(), { localCalls: 0, computeBootstrapCalls: 1, executeCalls: 1 });
    binding = { ...binding, revision: 8 };
    await harness.bridge.dispose();
  }

  {
    let bindingReads = 0;
    const harness = makeHarness({
      mode: 'prefer_server',
      bindingProvider: async () => ({ scopeId: 'scope:a', revision: ++bindingReads })
    });
    const result = await harness.bridge.execute({ operation: harness.operation, input: { values: [5, 2] } });
    assert.equal(result.source, 'local', 'a stale current binding rejects an otherwise valid server candidate');
    assert.equal(result.fallbackReason, 'MEMORY_SUITE_COMPUTE_BINDING_STALE');
    assert.equal(harness.counts().localCalls, 1, 'stale binding invokes the local kernel exactly once');
    await harness.bridge.dispose();
  }

  {
    const harness = makeHarness({
      mode: 'prefer_server',
      executeResultOverrides: () => ({ resultDigest: '0'.repeat(64) })
    });
    const result = await harness.bridge.execute({ operation: harness.operation, input: { values: [7, 8] }, binding: { revision: 1 } });
    assert.equal(result.source, 'local');
    assert.equal(result.fallbackReason, 'MEMORY_SUITE_COMPUTE_RESULT_DIGEST_MISMATCH');
    assert.equal(harness.counts().localCalls, 1, 'digest mismatch invokes one local fallback');
    await harness.bridge.dispose();
  }

  {
    let aborted = false;
    const harness = makeHarness({
      mode: 'prefer_server',
      defaultDeadlineMs: 130,
      localReserveMs: 70,
      fetch: async (url, init = {}) => {
        if (String(url).endsWith('/v1/compute/bootstrap')) return response(computeBootstrap());
        if (String(url).endsWith('/v1/compute/execute')) {
          return await new Promise((resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              aborted = true;
              const error = new Error('aborted');
              error.name = 'AbortError';
              reject(error);
            }, { once: true });
          });
        }
        throw new Error(`unexpected_url:${url}`);
      }
    });
    const startedAt = Date.now();
    const result = await harness.bridge.execute({ operation: harness.operation, input: { values: [4, 2] }, binding: { revision: 1 }, deadlineMs: 130, localReserveMs: 70 });
    assert.equal(result.source, 'local');
    assert.equal(harness.counts().localCalls, 1, 'timeout invokes one local fallback');
    assert.equal(aborted, true, 'remote deadline aborts the HTTP request');
    assert.ok(Date.now() - startedAt < 300, 'remote work yields before consuming the local reserve plus a broad safety margin');
    await harness.bridge.dispose();
  }

  {
    let active = 0;
    let maxActive = 0;
    const harness = makeHarness({
      mode: 'prefer_server',
      serverResult: async body => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(30);
        active -= 1;
        return { ranked: [...body.input.values].sort((a, b) => b - a) };
      }
    });
    const results = await Promise.all([1, 2, 3, 4].map(value => harness.bridge.execute({
      operation: harness.operation,
      input: { values: [value, value + 10] },
      binding: { revision: 1, lane: value }
    })));
    assert.ok(results.every(item => item.source === 'server'));
    assert.equal(maxActive, 4, 'compute calls are not serialized inside the bridge');
    assert.equal(harness.counts().localCalls, 0);
    await harness.bridge.dispose();
  }

  {
    let active = 0;
    let maxActive = 0;
    const fetchFor = (operation, fingerprint) => async (url, init = {}) => {
      if (String(url).endsWith('/v1/compute/bootstrap')) return response(computeBootstrap(operation, fingerprint));
      if (String(url).endsWith('/v1/compute/execute')) {
        const body = JSON.parse(init.body);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(40);
        active -= 1;
        return response(executePayload(body, { ranked: [...body.input.values].sort((a, b) => b - a) }));
      }
      throw new Error(`unexpected_url:${url}`);
    };
    const alpha = makeHarness({ mode: 'prefer_server', operation: 'test.alpha.v1', fingerprint: 'test-alpha-v1', fetch: fetchFor('test.alpha.v1', 'test-alpha-v1') });
    const beta = makeHarness({ mode: 'prefer_server', operation: 'test.beta.v1', fingerprint: 'test-beta-v1', fetch: fetchFor('test.beta.v1', 'test-beta-v1') });
    const [alphaResult, betaResult] = await Promise.all([
      alpha.bridge.execute({ operation: alpha.operation, input: { values: [1, 9] }, binding: { revision: 1 } }),
      beta.bridge.execute({ operation: beta.operation, input: { values: [2, 8] }, binding: { revision: 1 } })
    ]);
    assert.equal(alphaResult.source, 'server');
    assert.equal(betaResult.source, 'server');
    assert.equal(maxActive, 2, 'different bridge instances and operations are never globally serialized by the client');
    await alpha.bridge.dispose();
    await beta.bridge.dispose();
  }

  {
    const harness = makeHarness({ mode: 'shadow' });
    const applied = await harness.bridge.setMode('shadow');
    assert.equal(applied, 'local', 'legacy mode values remain readable during migration');
    assert.equal(await harness.bridge.getMode(), 'local', 'legacy shadow normalizes to local instead of creating a third execution mode');
    const result = await harness.bridge.execute({ operation: harness.operation, input: { values: [3, 9] }, binding: { revision: 2 } });
    assert.equal(result.source, 'local');
    assert.deepEqual(harness.counts(), { localCalls: 1, computeBootstrapCalls: 0, executeCalls: 0 });
    await harness.bridge.dispose();
  }

  {
    let clock = 1000;
    let serverHealthy = false;
    let executeNetworkCalls = 0;
    const harness = makeHarness({
      mode: 'prefer_server',
      now: () => clock,
      circuitFailureThreshold: 1,
      circuitBaseCooldownMs: 250,
      fetch: async (url, init = {}) => {
        if (String(url).endsWith('/v1/compute/bootstrap')) return response(computeBootstrap());
        if (String(url).endsWith('/v1/compute/execute')) {
          executeNetworkCalls += 1;
          const body = JSON.parse(init.body);
          if (!serverHealthy) return response({ ok: false, schema: 'memory-suite.compute.error.v1', error: 'worker_failed', code: 'COMPUTE_WORKER_FAILED' }, 503);
          return response(executePayload(body, { ranked: [...body.input.values].sort((a, b) => b - a) }));
        }
        throw new Error(`unexpected_url:${url}`);
      }
    });
    const first = await harness.bridge.execute({ operation: harness.operation, input: { values: [1] }, binding: { revision: 1 } });
    assert.equal(first.source, 'local');
    assert.equal(harness.bridge.status().circuit.state, 'open');
    const second = await harness.bridge.execute({ operation: harness.operation, input: { values: [2] }, binding: { revision: 1 } });
    assert.equal(second.source, 'local');
    assert.equal(executeNetworkCalls, 1, 'open circuit skips a repeated server execute');
    clock += 251;
    serverHealthy = true;
    const recovered = await harness.bridge.execute({ operation: harness.operation, input: { values: [3] }, binding: { revision: 1 } });
    assert.equal(recovered.source, 'server', 'one half-open request can close the circuit');
    assert.equal(harness.bridge.status().circuit.state, 'closed');
    await harness.bridge.dispose();
  }

  {
    let aborted = false;
    let localCalls = 0;
    const harness = makeHarness({
      mode: 'prefer_server',
      local: async input => { localCalls += 1; return { ranked: input.values }; },
      fetch: async (url, init = {}) => {
        if (String(url).endsWith('/v1/compute/bootstrap')) return response(computeBootstrap());
        if (String(url).endsWith('/v1/compute/execute')) {
          return await new Promise((resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              aborted = true;
              const error = new Error('aborted');
              error.name = 'AbortError';
              reject(error);
            }, { once: true });
          });
        }
        throw new Error(`unexpected_url:${url}`);
      }
    });
    const pending = harness.bridge.execute({ operation: harness.operation, input: { values: [1] }, binding: { revision: 1 }, deadlineMs: 1000, localReserveMs: 100 });
    await delay(30);
    assert.equal(await harness.bridge.dispose(), true);
    await assert.rejects(pending);
    assert.equal(aborted, true, 'dispose aborts an in-flight compute request');
    assert.equal(localCalls, 0, 'dispose never starts a late local fallback whose result could be adopted');
    await assert.rejects(
      () => harness.bridge.execute({ operation: harness.operation, input: { values: [2] }, binding: {} }),
      error => error?.code === 'MEMORY_SUITE_COMPUTE_BRIDGE_DISPOSED'
    );
  }

  {
    const harness = makeHarness({ mode: 'local' });
    await assert.rejects(
      () => harness.bridge.execute({ operation: harness.operation, operationId: 'short', input: { values: [1] }, binding: {} }),
      error => error?.code === 'MEMORY_SUITE_COMPUTE_OPERATION_ID_INVALID'
    );
    await assert.rejects(
      () => harness.bridge.execute({ operation: harness.operation, input: { values: [Number.NaN] }, binding: {} }),
      error => error?.code === 'MEMORY_SUITE_COMPUTE_INPUT_INVALID'
    );
    await assert.rejects(
      () => harness.bridge.execute({ operation: harness.operation, input: { values: new Map([['x', 1]]) }, binding: {} }),
      error => error?.code === 'MEMORY_SUITE_COMPUTE_INPUT_INVALID'
    );
    assert.deepEqual(harness.counts(), { localCalls: 0, computeBootstrapCalls: 0, executeCalls: 0 }, 'invalid wire DTOs fail before local or network execution');
    assert.equal(await harness.bridge.setMode('shadow'), 'local');
    assert.equal(await harness.bridge.getMode(true), 'local', 'legacy shadow values durably migrate to the local mode');
    await harness.bridge.dispose();
  }

  process.stdout.write('compute_bridge_test: PASS\n');
})().catch(error => {
  process.stderr.write(`compute_bridge_test: FAIL\n${error.stack || error}\n`);
  process.exitCode = 1;
});
