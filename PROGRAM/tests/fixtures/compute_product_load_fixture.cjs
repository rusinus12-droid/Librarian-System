'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DEFINITIONS, executeOperation } = require('../../server/compute/registry.cjs');

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const fileDigest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const repositoryDigest = file => crypto.createHash('sha256')
  .update(JSON.stringify([file, `${file}-wal`].map(candidate => (
    fs.existsSync(candidate)
      ? { name: path.basename(candidate), size: fs.statSync(candidate).size, sha256: fileDigest(candidate) }
      : { name: path.basename(candidate), missing: true }
  ))))
  .digest('hex');

async function jsonFetch(url, init = {}) {
  const response = await fetch(url, init);
  const raw = await response.text();
  return { response, payload: raw ? JSON.parse(raw) : {} };
}

async function computeIdentity(base, pluginId, operation) {
  const bootstrap = await jsonFetch(`${base}/v1/compute/bootstrap`, {
    method: 'POST',
    headers: { 'X-Memory-Suite-Plugin': pluginId }
  });
  assert.equal(bootstrap.response.status, 200, JSON.stringify(bootstrap.payload));
  const capability = bootstrap.payload.operations.find(item => item.operation === operation);
  assert.ok(capability, `${pluginId} must receive ${operation} without a pairing key`);
  return {
    namespace: bootstrap.payload.authorization.namespace,
    operation,
    fingerprint: capability.algorithmFingerprint,
    headers: {
      Authorization: `Bearer ${bootstrap.payload.token}`,
      'X-Memory-Suite-Plugin': pluginId,
      'Content-Type': 'application/json'
    }
  };
}

async function submitProductJob(base, spec, options = {}) {
  const operationId = String(options.operationId || '').trim();
  assert.match(operationId, /^[A-Za-z0-9._:-]{12,240}$/);
  const result = await jsonFetch(`${base}/v1/compute/jobs`, {
    method: 'POST',
    headers: spec.identity.headers,
    body: JSON.stringify({
      namespace: spec.identity.namespace,
      operation: spec.identity.operation,
      operationId,
      algorithmFingerprint: spec.identity.fingerprint,
      input: spec.input,
      binding: options.binding || {
        schema: 'memory-suite.compute.product-load-binding.v1',
        namespace: spec.identity.namespace,
        operationId
      },
      lane: options.lane || 'background',
      deadlineMs: Number(options.deadlineMs || 30000)
    })
  });
  assert.equal(result.response.status, 202, JSON.stringify(result.payload));
  return { spec, operationId, job: result.payload.result };
}

async function productJobStatus(base, submitted) {
  const result = await jsonFetch(`${base}/v1/compute/jobs/${submitted.job.jobId}`, {
    headers: submitted.spec.identity.headers
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  return result.payload.result;
}

async function waitProductResult(base, submitted, timeoutMs = 35000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await productJobStatus(base, submitted);
    if (current.state === 'succeeded') {
      const result = await jsonFetch(`${base}/v1/compute/jobs/${submitted.job.jobId}/result`, {
        headers: submitted.spec.identity.headers
      });
      assert.equal(result.response.status, 200, JSON.stringify(result.payload));
      return { ...submitted, status: current, result: result.payload.result };
    }
    if (['failed', 'cancelled', 'expired'].includes(current.state)) {
      throw new Error(`product_load_job_failed:${JSON.stringify(current)}`);
    }
    await delay(15);
  }
  throw new Error(`product_load_job_timeout:${submitted.job.jobId}`);
}

async function waitForProductLoad(base, submissions, options = {}) {
  const deadline = Date.now() + Number(options.timeoutMs || 5000);
  while (Date.now() < deadline) {
    const states = await Promise.all(submissions.map(item => productJobStatus(base, item)));
    const running = states.filter(item => item.state === 'running').length;
    const queued = states.filter(item => item.state === 'queued').length;
    if (running >= Number(options.minRunning || 1) && (!options.requireQueued || queued > 0)) return states;
    await delay(10);
  }
  throw new Error('product_load_never_reached_expected_active_state');
}

function repeatToLength(seed, length) {
  const source = `${seed} `;
  return source.repeat(Math.ceil(length / source.length)).slice(0, length);
}

function flashbackInput() {
  return {
    dimensions: 1024,
    texts: Array.from({ length: 128 }, (_, index) => repeatToLength(
      `flashback memory episode ${index} 세계관 기억 인물 관계 chronology anchor-${index}`,
      9000
    ))
  };
}

function liaInput() {
  const queryTokens = Array.from({ length: 120 }, (_, index) => `worldtoken${index}`);
  return {
    version: 'lia_lore_reranker_v2',
    purpose: 'world',
    topK: 64,
    query: `${queryTokens.join(' ')} 세계관 규칙 사회 구조 기술 마법 금지`,
    entries: Array.from({ length: 560 }, (_, index) => ({
      position: index,
      loreId: `product-lore-${index}`,
      key: index % 17 === 0 ? `World Rule ${index}` : `Lore ${index}`,
      secondkey: `worldtoken${index % queryTokens.length}`,
      comment: index % 29 === 0 ? 'Canon law and social structure' : 'World archive',
      content: repeatToLength(
        `worldtoken${index % queryTokens.length} culture academy geography timeline entry-${index}`,
        1800
      ),
      mode: index % 113 === 0 ? 'constant' : 'normal',
      alwaysActive: index % 181 === 0,
      insertorder: index,
      source: index % 2 === 0 ? 'character_lore' : 'module_lore',
      score: index % 181
    }))
  };
}

function libraInput() {
  const tokens = Array.from({ length: 150 }, (_, index) => `recalltoken${index}`);
  const fieldText = (field, index) => repeatToLength(
    `${field} recalltoken${index % tokens.length} recalltoken${(index * 7) % tokens.length} 아카데미 세계 규칙 chronology relation`,
    1700
  );
  const fields = [
    'summary', 'recall_keys', 'characters_relations', 'narrative_open_threads',
    'chronology', 'world_scene', 'facts_uncertainty', 'full_text'
  ];
  return {
    schema: 'libra.recall-bm25f.input.v1',
    queryText: `${tokens.join(' ')} 아카데미 세계 규칙 관계 연대기`,
    documents: Array.from({ length: 64 }, (_, index) => ({
      position: index,
      id: `product-memory-${index}:r1`,
      fields: Object.fromEntries(fields.map(field => [field, fieldText(field, index)]))
    }))
  };
}

function hayakuInput() {
  const signalNames = [
    'bm25fSignal', 'identitySignal', 'canonicalExactSignal', 'associationSignal',
    'charNgramSignal', 'lexicalCoverageSignal', 'sparsePhraseSignal',
    'bm25Signal', 'entitySignal', 'canonicalSignal', 'frameSignal', 'locatorSignal', 'phraseSignal'
  ];
  return {
    schema: 'hayaku.sparse-rrf-fusion.input.v1',
    k: 60,
    blend: 0.12,
    epsilon: 0.000001,
    rows: Array.from({ length: 256 }, (_, position) => ({
      position,
      id: `product-packet-${position}`,
      score: ((position * 37) % 135) / 100,
      signals: Object.fromEntries(signalNames.map((name, signalIndex) => [
        name,
        ((position * (signalIndex + 3) + signalIndex * 11) % 135) / 100
      ]))
    }))
  };
}

async function createProductSpecs(base) {
  // Current role contract retires LIA server ownership. Preserve the denied path.
  const retired = await jsonFetch(`${base}/v1/compute/bootstrap`, { method: 'POST', headers: { 'X-Memory-Suite-Plugin': 'lia_persona_linker' } });
  assert.equal(retired.response.status, 403);
  assert.equal(retired.payload.code, 'COMPUTE_OWNER_PLUGIN_REQUIRED');
  assert.equal(Object.hasOwn(retired.payload, 'token'), false);
  const descriptors = [
    ['flashback_memory', DEFINITIONS['flashback.hash-embedding-batch.v1'], flashbackInput()],
    ['libra', DEFINITIONS['libra.recall-bm25f.v1'], libraInput()],
    ['hayaku_locator_continuity', DEFINITIONS['hayaku.sparse-rrf-fusion.v1'], hayakuInput()]
  ];
  const identities = await Promise.all(descriptors.map(([pluginId, definition]) => (
    computeIdentity(base, pluginId, definition.operation)
  )));
  return descriptors.map(([, , input], index) => ({ identity: identities[index], input }));
}

function executeProductLocals(specs) {
  return Object.fromEntries(specs.map(spec => [
    spec.identity.namespace,
    executeOperation(spec.identity.operation, spec.input)
  ]));
}

function percentile(values, ratio) {
  const ordered = values.slice().sort((left, right) => left - right);
  if (!ordered.length) return 0;
  return ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * ratio) - 1))];
}

function peakProductConcurrency(results) {
  const events = [];
  for (const item of results) {
    const startedAt = Number(item.status.startedAt || 0);
    const workerMs = Math.max(1, Number(item.result?.timing?.workerMs || 0));
    events.push({ at: startedAt, delta: 1, namespace: item.spec.identity.namespace });
    events.push({ at: startedAt + workerMs, delta: -1, namespace: item.spec.identity.namespace });
  }
  events.sort((left, right) => left.at - right.at || left.delta - right.delta);
  const active = new Map();
  let activeJobs = 0;
  let peakJobs = 0;
  let peakNamespaces = 0;
  for (const event of events) {
    activeJobs = Math.max(0, activeJobs + event.delta);
    const next = Math.max(0, Number(active.get(event.namespace) || 0) + event.delta);
    if (next) active.set(event.namespace, next);
    else active.delete(event.namespace);
    peakJobs = Math.max(peakJobs, activeJobs);
    peakNamespaces = Math.max(peakNamespaces, active.size);
  }
  return { peakJobs, peakNamespaces };
}

function summarizeProductResults(results) {
  return Object.fromEntries(['flashback', 'libra', 'hayaku'].map(namespace => {
    const rows = results.filter(item => item.spec.identity.namespace === namespace);
    const values = key => rows.map(item => Number(item.result.timing[key] || 0));
    return [namespace, {
      jobs: rows.length,
      inputBytes: Buffer.byteLength(JSON.stringify(rows[0].spec.input), 'utf8'),
      resultBytesP95: percentile(rows.map(item => Number(item.status.resultBytes || 0)), 0.95),
      queueP50Ms: percentile(values('queueMs'), 0.5),
      queueP95Ms: percentile(values('queueMs'), 0.95),
      workerP50Ms: percentile(values('workerMs'), 0.5),
      workerP95Ms: percentile(values('workerMs'), 0.95),
      totalP50Ms: percentile(values('totalMs'), 0.5),
      totalP95Ms: percentile(values('totalMs'), 0.95)
    }];
  }));
}

module.exports = {
  delay,
  repositoryDigest,
  jsonFetch,
  computeIdentity,
  submitProductJob,
  productJobStatus,
  waitProductResult,
  waitForProductLoad,
  flashbackInput,
  liaInput,
  libraInput,
  hayakuInput,
  createProductSpecs,
  executeProductLocals,
  percentile,
  peakProductConcurrency,
  summarizeProductResults
};
