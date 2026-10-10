'use strict';

// D05 local baseline harness. Run from any working directory with:
//   node --expose-gc path/to/tests/libra_main_memory_closure_scale_benchmark.cjs
//
// This drives LIBRA's shipped debugResolveRecallContinuityClosure implementation
// through the existing VM fixture. The only synthetic boundary is readFact: it
// maps generated committed refs to one canonical artifact seeded by that fixture.
// No live provider, server, filesystem store, or model-quality claim is involved.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { monitorEventLoopDelay, performance } = require('node:perf_hooks');
const { fixture } = require('./fixtures/libra_unified_runtime_fixture.cjs');

const PROGRAM = path.resolve(__dirname, '..');
const LIBRA_SOURCE = path.join(PROGRAM, 'plugins', 'LIBRA.js');
const REF_COUNTS = [100, 1000, 10000];
const REPEATED_PASSES = 2;
const REFERENCE_BASELINE_LIMITS = Object.freeze({ maxRefs: 48, maxFacts: 240 });
const nowNs = () => process.hrtime.bigint();
const elapsedMs = started => Number(nowNs() - started) / 1e6;
const rounded = value => Number.isFinite(value) ? Number(value.toFixed(3)) : null;
const sha256File = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const textDigest = value => {
  const body = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  let hash = 2166136261 >>> 0;
  for (let index = 0; index < body.length; index += 1) {
    hash ^= body.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  hash ^= 31;
  hash = Math.imul(hash, 16777619) >>> 0;
  return `${hash.toString(16).padStart(8, '0')}:${body.length + 1}`;
};

const memoryEnvelopeForRef = (ref, canonicalArtifact) => ({
  key: ref.key,
  id: ref.memoryId,
  memoryId: ref.memoryId,
  revision: ref.revision,
  sourceDigest: ref.sourceDigest,
  artifactDigest: ref.artifactDigest,
  artifactSchema: ref.artifactSchema,
  turnRange: ref.turnRange,
  sessionEpoch: ref.sessionEpoch,
  worldlineId: ref.worldlineId || 'main',
  logicalWorldlineId: ref.logicalWorldlineId || 'main',
  scopeKey: ref.scopeKey || '',
  canonicalArtifact
});

const engineLimitsFromSource = source => {
  const readLimit = name => {
    const match = source.match(new RegExp(`const\\s+${name}\\s*=\\s*(\\d+)\\s*;`));
    assert.ok(match, `shipped source exposes a parseable ${name} limit`);
    return Number(match[1]);
  };
  return {
    maxRefs: readLimit('RECALL_CLOSURE_MAX_REFS'),
    maxFacts: readLimit('RECALL_CLOSURE_MAX_FACTS')
  };
};

const readRegistryFromFixture = vm => {
  const row = [...vm.values.entries()].find(([key]) => /:entity-registry:v2$/.test(key));
  assert.ok(row, 'seed run wrote the real entity registry into fixture storage');
  const stored = JSON.parse(row[1]);
  assert.ok(Array.isArray(stored.entities) && stored.entities.length > 0,
    'seed registry contains resolved entities');
  return { entities: stored.entities, splitRetiredNames: stored.splitRetiredNames || [] };
};

const makeSyntheticManifest = (count, seedRef) => {
  const memories = {};
  const baseStart = Math.max(1, Number(seedRef.turnRange?.start || 1));
  const epoch = Number(seedRef.sessionEpoch || 0);
  for (let index = 0; index < count; index += 1) {
    const start = baseStart + (index * 5);
    const ref = {
      ...seedRef,
      memoryId: `d05-synthetic-${count}-${index + 1}`,
      key: `d05-benchmark/${count}/${index + 1}`,
      status: 'committed',
      revision: index + 1,
      sessionEpoch: epoch,
      turnRange: { start, end: start + 4 },
      sourceDigest: `synthetic:${count}:${index + 1}`,
      // The seed's unifiedOriginDigest describes the SEED's identity tuple
      // (its own memoryId/revision/turnRange/artifactDigest). A synthetic ref changes all of
      // those, so inheriting that digest would assert an origin the envelope cannot reproduce,
      // and the engine correctly refuses the read (measured: every synthetic read was rejected
      // as closure_ref_artifact_digest_mismatch, refsScanned stayed 0). The envelope this ref is
      // paired with is self-consistent, so the stale origin digest is dropped.
      unifiedOriginDigest: ''
    };
    memories[String(index + 1)] = ref;
  }
  return { memories };
};

const runClosurePass = async ({ api, selectedFacts, manifest, registry, head, canonicalArtifact, successorArtifact, maxFacts, maxRefs }) => {
  let readFactCalls = 0;
  let factRowsDelivered = 0;
  let canonicalPayloadBytesDelivered = 0;
  const payloadBytes = Buffer.byteLength(JSON.stringify(canonicalArtifact), 'utf8');
  const baseStart = Number(Object.values(manifest.memories || {})[0]?.turnRange?.start || 1);
  const loopDelay = monitorEventLoopDelay({ resolution: 1 });
  const memoryBefore = process.memoryUsage();
  loopDelay.enable();
  const started = nowNs();
  let closure;
  try {
    closure = await api.debugResolveRecallContinuityClosure({
      selectedFacts,
      manifest,
      head,
      registry,
      readFact: async ref => {
        const artifactForRef = Number(ref?.turnRange?.start || 0) > baseStart ? successorArtifact : canonicalArtifact;
        readFactCalls += 1;
        factRowsDelivered += artifactForRef.facts.length;
        canonicalPayloadBytesDelivered += Buffer.byteLength(JSON.stringify(artifactForRef), 'utf8');
        return memoryEnvelopeForRef(ref, artifactForRef);
      },
      budget: { maxFacts },
      signal: null
    });
  } finally {
    loopDelay.disable();
  }
  const durationMs = elapsedMs(started);
  const memoryAfter = process.memoryUsage();
  const eventLoopSamples = Number(loopDelay.count || 0);
  const eventLoopDelay = {
    status: eventLoopSamples >= 3 ? 'sampled' : 'insufficient_sample',
    resolutionMs: 1,
    sampleCount: eventLoopSamples,
    p99Ms: eventLoopSamples ? rounded(loopDelay.percentile(99) / 1e6) : null,
    maxMs: eventLoopSamples ? rounded(loopDelay.max / 1e6) : null
  };

  assert.ok(closure && Array.isArray(closure.facts), 'real closure API returns facts');
  assert.equal(readFactCalls, closure.diagnostics.readCount,
    'instrumented readFact calls agree with engine readCount');
  assert.equal(typeof closure.diagnostics.scannedFacts, 'number',
    'engine exposes an explicit inspected-fact count');
  assert.ok(closure.diagnostics.refsAfterSelection <= maxRefs,
    'real closure selection is bounded by the parsed shipped ref limit');

  return {
    durationMs: rounded(durationMs),
    memory: {
      heapUsedBeforeBytes: memoryBefore.heapUsed,
      heapUsedAfterBytes: memoryAfter.heapUsed,
      heapUsedDeltaBytes: memoryAfter.heapUsed - memoryBefore.heapUsed,
      rssBeforeBytes: memoryBefore.rss,
      rssAfterBytes: memoryAfter.rss,
      rssDeltaBytes: memoryAfter.rss - memoryBefore.rss,
      gcAvailable: typeof global.gc === 'function'
    },
    eventLoopDelay,
    reader: {
      readFactCalls,
      canonicalPayloadFactRowsDelivered: factRowsDelivered,
      canonicalPayloadBytesPerRead: payloadBytes,
      canonicalPayloadBytesDelivered,
      factsInEachSyntheticCanonicalPayload: canonicalArtifact.facts.length
    },
    closure: {
      currentness: closure.currentness,
      closureComplete: closure.closureComplete,
      selectedFactCount: closure.diagnostics.selectedCount,
      closureFactCount: closure.diagnostics.closureCount,
      engineInspectedFactCount: closure.diagnostics.scannedFacts,
      diagnostics: closure.diagnostics,
      returnedFactCount: closure.facts.length
    }
  };
};

const runCancellationProbe = async ({ api, selectedFacts, manifest, registry, head, canonicalArtifact, successorArtifact, maxFacts }) => {
  const controller = new AbortController();
  const payloadBytes = Buffer.byteLength(JSON.stringify(canonicalArtifact), 'utf8');
  let readFactCalls = 0;
  let factRowsDelivered = 0;
  let abortRequestedAt = null;
  const startedAt = performance.now();
  const abortTimer = setTimeout(() => {
    abortRequestedAt = performance.now();
    controller.abort();
  }, 0);
  const baseStart = Number(Object.values(manifest.memories || {})[0]?.turnRange?.start || 1);
  let closure;
  let finishedAt;
  try {
    closure = await api.debugResolveRecallContinuityClosure({
      selectedFacts,
      manifest,
      head,
      registry,
      readFact: async ref => {
        const artifactForRef = Number(ref?.turnRange?.start || 0) > baseStart ? successorArtifact : canonicalArtifact;
        readFactCalls += 1;
        // A controlled, synthetic storage-boundary delay gives the timer a chance
        // to abort during an in-flight read. This is not a provider or I/O latency.
        await new Promise(resolve => setTimeout(resolve, 5));
        factRowsDelivered += artifactForRef.facts.length;
        return memoryEnvelopeForRef(ref, artifactForRef);
      },
      budget: { maxFacts },
      signal: controller.signal
    });
    finishedAt = performance.now();
  } finally {
    clearTimeout(abortTimer);
  }
  const abortedObserved = (closure?.diagnostics?.reasons || []).includes('aborted');
  const status = abortRequestedAt === null
    ? 'completed-before-abort'
    : (abortedObserved ? 'aborted-during-call' : 'abort-requested-not-observed');
  return {
    status,
    timerDelayMs: 0,
    syntheticReadDelayMs: 5,
    timingDefinition: 'abortRequestLatencyMs includes synchronous closure work before the timer can run; cancellationLatencyAfterAbortMs starts only when AbortController.abort() fires',
    abortRequestLatencyMs: abortRequestedAt === null ? null : rounded(abortRequestedAt - startedAt),
    cancellationLatencyAfterAbortMs: status === 'aborted-during-call'
      ? rounded(finishedAt - abortRequestedAt) : null,
    readFactCalls,
    canonicalPayloadFactRowsDelivered: factRowsDelivered,
    canonicalPayloadBytesPerRead: payloadBytes,
    observedAbortedReason: abortedObserved,
    closureComplete: closure?.closureComplete ?? null,
    currentness: closure?.currentness ?? null,
    diagnostics: closure?.diagnostics ?? null
  };
};

const runBenchmark = async ({ runLabel = 'unlabeled-comparison-run' } = {}) => {
  const pluginHashBefore = sha256File(LIBRA_SOURCE);
  const source = fs.readFileSync(LIBRA_SOURCE, 'utf8');
  const engineLimits = engineLimitsFromSource(source);
  assert.ok(engineLimits.maxRefs > 0, 'shipped closure ref limit is positive');
  assert.ok(engineLimits.maxFacts > 0, 'shipped closure fact limit is positive');

  let seed = null;
  let cleanupComplete = false;
  let resultRecord = null;
  try {
    seed = await fixture({ mode: 'unified' });
    const job = await seed.run();
    assert.equal(job.completed, 1, 'synthetic seed job completed in the VM fixture');
    const storedManifest = seed.getManifest();
    const seedRef = Object.values(storedManifest?.memories || {})[0];
    assert.ok(seedRef?.key, 'synthetic seed has a committed canonical ref');
    const storedMemory = JSON.parse(seed.r.values.get(seedRef.key));
    const canonicalArtifact = storedMemory?.canonicalArtifact;
    assert.equal(canonicalArtifact?.schema, 'libra.canonical_artifact.v4',
      'seed is a readable canonical artifact');
    const selectedFact = canonicalArtifact.facts.find(fact => fact.tempFactId === 'f7');
    assert.ok(selectedFact, 'seed contains the real selected canonical fact f7');
    const successorArtifact = JSON.parse(JSON.stringify(canonicalArtifact));
    const successorFact = successorArtifact.facts.find(fact => fact.tempFactId === 'f7');
    successorFact.values.holderRef = 'mina';
    successorFact.text = '지호가 은빛 열쇠를 민아에게 반환했다.';
    successorFact.evidenceSpans = successorFact.evidenceSpans.map(span => ({
      ...span, quote: '지호가 은빛 열쇠를 민아에게 반환했다.'
    }));
    const successorArtifactDigest = textDigest(successorArtifact);
    const registry = readRegistryFromFixture(seed.r);
    const head = seed.getHead();
    const results = [];
    let first100Result = null;

    for (const count of REF_COUNTS) {
      const manifest = makeSyntheticManifest(count, seedRef);
      const refs = Object.values(manifest.memories);
      for (const ref of refs.slice(1)) ref.artifactDigest = successorArtifactDigest;
      const selectedFacts = [{ fact: selectedFact, artifact: canonicalArtifact, ref: refs[0] }];
      const passes = [];
      for (let pass = 1; pass <= REPEATED_PASSES; pass += 1) {
        if (typeof global.gc === 'function') global.gc();
        const measured = await runClosurePass({
          api: seed.r.api, selectedFacts, manifest, registry, head, canonicalArtifact, successorArtifact,
          maxFacts: engineLimits.maxFacts, maxRefs: engineLimits.maxRefs
        });
        assert.equal(measured.closure.selectedFactCount, 1,
          `${count} refs: selected fact reaches closure`);
        assert.ok(measured.reader.readFactCalls > 0,
          `${count} refs: closure performs actual canonical reads`);
        assert.ok(measured.reader.canonicalPayloadFactRowsDelivered > 0,
          `${count} refs: reader delivers actual canonical fact rows`);
        assert.equal(measured.closure.engineInspectedFactCount, engineLimits.maxFacts,
          `${count} refs: engine inspected facts reach the configured maxFacts bound`);
        assert.ok(measured.closure.diagnostics.reasons.includes('closure_fact_limit'),
          `${count} refs: closure discloses its inspected-fact cap`);
        if (count === 100 && pass === 1) {
          assert.ok(measured.closure.closureFactCount > 0,
            '100-ref baseline produces real successor closure facts');
          first100Result = { manifest, selectedFacts, measured };
        }
        passes.push({
          measurement: pass === 1 ? 'first-measurement' : 'repeated-measurement',
          cacheClaim: 'no closure cache is exercised or claimed',
          ...measured
        });
      }
      results.push({
        workload: 'synthetic canonical refs backed by one fixture-seeded canonical artifact',
        canonicalRefCount: count,
        syntheticReferences: true,
        selectedCanonicalFacts: 1,
        manifestUtf8Bytes: Buffer.byteLength(JSON.stringify(manifest), 'utf8'),
        configuredEngineLimits: engineLimits,
        referenceBaselineLimits: REFERENCE_BASELINE_LIMITS,
        passes
      });
    }

    assert.ok(first100Result, '100-ref workload is available for a budget-zero real-read check');
    assert.ok(first100Result.measured.closure.closureFactCount > 0,
      'generous-budget baseline produced non-empty closure before zero-budget probe');
    let zeroBudgetReadFactCalls = 0;
    let zeroBudgetCanonicalPayloadFactRowsDelivered = 0;
    let zeroBudgetCanonicalPayloadBytesDelivered = 0;
    const zeroBudget = await seed.r.api.debugResolveRecallContinuityClosure({
      selectedFacts: first100Result.selectedFacts,
      manifest: first100Result.manifest,
      head,
      registry,
      readFact: async ref => {
        zeroBudgetReadFactCalls += 1;
        const artifactForRef = Number(ref?.turnRange?.start || 0) > Number(first100Result.manifest.memories['1']?.turnRange?.start || 1)
          ? successorArtifact : canonicalArtifact;
        zeroBudgetCanonicalPayloadFactRowsDelivered += artifactForRef.facts.length;
        zeroBudgetCanonicalPayloadBytesDelivered += Buffer.byteLength(JSON.stringify(artifactForRef), 'utf8');
        return memoryEnvelopeForRef(ref, artifactForRef);
      },
      budget: { maxFacts: 0 },
      signal: null
    });
    assert.ok(zeroBudgetReadFactCalls > 0, 'zero-budget probe performs real closure reads');
    assert.equal(zeroBudget.diagnostics.readCount, zeroBudgetReadFactCalls,
      'zero-budget read callback count matches engine diagnostics');
    assert.equal(typeof zeroBudget.diagnostics.scannedFacts, 'number',
      'zero-budget probe exposes an explicit inspected-fact count');
    assert.equal(zeroBudget.diagnostics.closureCount, 0,
      'zero-budget probe returns no added closure facts');
    assert.equal(zeroBudget.currentness, 'last-known',
      'zero-budget probe retains honest last-known currentness after reads');
    assert.equal(zeroBudget.closureComplete, false,
      'zero-budget probe discloses truncation');
    assert.ok(zeroBudget.diagnostics.reasons.includes('closure_budget'),
      'zero-budget probe names the actual closure budget truncation');

    const largest = results.find(result => result.canonicalRefCount === 10000);
    const largestManifest = makeSyntheticManifest(10000, seedRef);
    const largestRefs = Object.values(largestManifest.memories);
    for (const ref of largestRefs.slice(1)) ref.artifactDigest = successorArtifactDigest;
    const cancellation = await runCancellationProbe({
      api: seed.r.api,
      selectedFacts: [{ fact: selectedFact, artifact: canonicalArtifact, ref: largestRefs[0] }],
      manifest: largestManifest,
      registry,
      head,
      canonicalArtifact,
      successorArtifact,
      maxFacts: engineLimits.maxFacts
    });
    assert.equal(largest.canonicalRefCount, 10000, 'cancellation uses the largest canonical-ref workload');

    resultRecord = {
      record: 'd05_local_scale_baseline',
      schema: 'libra.d05.local_closure_benchmark.v1',
      runLabel: String(runLabel || 'unlabeled-comparison-run').slice(0, 120),
      acceptanceId: 'D05-local-scale-baseline',
      verificationIds: [
        '100-1000-10000-refs', 'cold-warm-read-count', 'cancellation-latency', 'actual-exit'
      ],
      boundary: 'generic shipped recall-closure engine only; B4 lifecycle proof-read remains a separate verification boundary',
      workloadDescription: 'synthetic committed refs all read one fixture-seeded canonical artifact; no live provider and no end-to-end model-quality claim',
      firstVersusRepeated: 'first-measurement and repeated-measurement are reported; no warm-cache claim is made',
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      gcExposed: typeof global.gc === 'function',
      fixtureSeed: {
        jobCompleted: job.completed,
        syntheticProviderStubCalls: seed.control.calls.length,
        canonicalArtifactSchema: canonicalArtifact.schema,
        canonicalArtifactFactCount: canonicalArtifact.facts.length,
        registryEntityCount: registry.entities.length,
        selectedFactTempId: selectedFact.tempFactId
      },
      configuredEngineLimits: engineLimits,
      referenceBaselineLimits: REFERENCE_BASELINE_LIMITS,
      configuredLimitsDifferFromReferenceBaseline:
        engineLimits.maxRefs !== REFERENCE_BASELINE_LIMITS.maxRefs
        || engineLimits.maxFacts !== REFERENCE_BASELINE_LIMITS.maxFacts,
      workloads: results,
      zeroBudgetCurrentnessProbe: {
        status: 'verified-real-read-truncation',
        precedingGenerousBudgetClosureFactCount: first100Result.measured.closure.closureFactCount,
        readFactCalls: zeroBudgetReadFactCalls,
        canonicalPayloadFactRowsDelivered: zeroBudgetCanonicalPayloadFactRowsDelivered,
        canonicalPayloadBytesDelivered: zeroBudgetCanonicalPayloadBytesDelivered,
        engineInspectedFactCount: zeroBudget.diagnostics.scannedFacts,
        engineInspectedFactCountNote: 'engine inspected facts are reported from diagnostics.scannedFacts; callback-delivered payload rows are reported separately',
        diagnostics: zeroBudget.diagnostics,
        closureFactCount: zeroBudget.diagnostics.closureCount,
        currentness: zeroBudget.currentness,
        closureComplete: zeroBudget.closureComplete
      },
      cancellation,
      thresholdProposal: {
        status: 'no numeric performance threshold selected from this single-process baseline',
        method: 'repeat baseline and candidate in separate processes on the same host/runtime, estimate run-to-run noise, then agree a relative threshold; until then use measurements as comparisons rather than an SLA',
        referenceBaselineLimits: REFERENCE_BASELINE_LIMITS,
        configuredLimits: engineLimits,
        configuredLimitsDifferFromReferenceBaseline:
          engineLimits.maxRefs !== REFERENCE_BASELINE_LIMITS.maxRefs
          || engineLimits.maxFacts !== REFERENCE_BASELINE_LIMITS.maxFacts
      },
      cleanupComplete: false,
      pluginSourceSha256BeforeCleanup: pluginHashBefore
    };
    return resultRecord;
  } finally {
    if (seed?.r) {
      try {
        await seed.r.cleanup();
      } finally {
        seed.r.values.clear();
        cleanupComplete = true;
      }
    }
    const pluginHashAfter = sha256File(LIBRA_SOURCE);
    assert.equal(pluginHashAfter, pluginHashBefore, 'benchmark left shipped LIBRA source bytes unchanged');
    if (resultRecord) {
      resultRecord.cleanupComplete = cleanupComplete;
      resultRecord.pluginSourceSha256AfterCleanup = pluginHashAfter;
    }
    if (!cleanupComplete) throw new Error('fixture cleanup did not complete');
  }
};

if (require.main === module) {
  process.on('exit', exitCode => {
    try {
      fs.writeSync(1, `${JSON.stringify({
        record: 'actual_process_exit',
        exitCode,
        naturalExit: true
      })}\n`);
    } catch (_) {}
  });
  const labelArgument = process.argv.slice(2).find(argument => argument.startsWith('--run-label='));
  const runLabel = labelArgument ? labelArgument.slice('--run-label='.length) : 'unlabeled-comparison-run';
  runBenchmark({ runLabel }).then(result => {
    console.log(JSON.stringify(result));
  }).catch(error => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}

module.exports = { makeSyntheticManifest, runBenchmark };
