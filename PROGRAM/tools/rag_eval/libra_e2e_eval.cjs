'use strict';
// LIBRA end-to-end RAG evaluation with a real extraction model and real embeddings.
//
// Runs the deployed LIBRA on the test VM host (tests/fixtures/libra_server_runtime_fixture.cjs)
// over the shared Korean fixture conversation. Every host runLLMModel call (canonical
// artifacts, Micro memory) goes to a real chat model; document and query vectors go to a
// real embedding provider. Each question then runs the shipped recall path
// (previewUnifiedMemoryRecall) and is a hit when every expected string is in the
// delivered memory text.
//   RAG_EVAL_LLM_URL     OpenAI-compatible chat base URL (…/v1), e.g. https://ollama.com/v1
//   RAG_EVAL_LLM_KEY / RAG_EVAL_LLM_MODEL
//   RAG_EVAL_EMBED_URL / RAG_EVAL_EMBED_KEY / RAG_EVAL_EMBED_MODEL (optional; lexical otherwise)
// Node's built-in fetch ignores HTTPS_PROXY; run with NODE_USE_ENV_PROXY=1 behind a proxy.
// --live        replay the chat turn by turn through the output listener, as RisuAI does,
//               so per-turn Micro memory is produced before the canonical scan.
// RAG_EVAL_LLM_LOG=file appends every model request/response (JSON lines) for inspection.
// --state file  reuse the captured plugin_only storage from an earlier run (skips extraction);
//               the file is written after a fresh capture.
// --require-state  fail if the snapshot is missing; do not repair/re-embed its documents.
// --capture-only   extract and save without running recall (use --live for Micro).
// --repeat N       repeat the question suite in the same runtime (default 1).
// --entrypoint before-request  score only evidence returned by RisuAI's actual hook.
// --corpus-index local-simulated --index-rebuilds N  replay a saved snapshot with
//               fake-indexeddb in the VM; native IndexedDB is tested separately.
// Snapshots and model logs can contain credentials: keep them outside the repository.
// Usage: node tools/rag_eval/libra_e2e_eval.cjs [fixture.json] [--mode plugin_only|server_only] [--json out.json] [--state file]
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { createHash } = require('node:crypto');
const { serverFixture } = require('../../tests/fixtures/libra_server_runtime_fixture.cjs');

const argv = process.argv.slice(2);
const option = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const fixturePath = argv.find((value, i) => value.endsWith('.json') && !['--json', '--state'].includes(argv[i - 1]))
  || path.join(__dirname, '../../tests/fixtures/rag_eval_ko_v1.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const mode = option('--mode') || 'plugin_only';
const statePath = option('--state');
const requireState = argv.includes('--require-state');
const captureOnly = argv.includes('--capture-only');
const repeats = Number(option('--repeat') || 1);
const entrypoint = option('--entrypoint') || 'preview';
const corpusIndex = option('--corpus-index') || 'runtime';
const indexRebuilds = Number(option('--index-rebuilds') || 1);
if (!['runtime','local-simulated'].includes(corpusIndex) || !Number.isSafeInteger(indexRebuilds) || indexRebuilds < 1 || indexRebuilds > 8) throw new Error('Invalid corpus index/rebuild options');
if (corpusIndex === 'local-simulated' && (!requireState || mode !== 'plugin_only')) throw new Error('Simulated local index requires an existing plugin_only --require-state snapshot');
let contextGlobals;
if (corpusIndex === 'local-simulated') {
  let fake; try { fake = require('fake-indexeddb'); } catch (_) { fake = require('../../build-support/node_modules/fake-indexeddb'); }
  contextGlobals = { indexedDB: new fake.IDBFactory() };
}
if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 20) throw new Error('--repeat must be 1..20');
if (!['preview', 'before-request'].includes(entrypoint)) throw new Error('Unknown --entrypoint');
if (requireState && (mode !== 'plugin_only' || !statePath || !fs.existsSync(statePath))) throw new Error('--require-state needs an existing plugin_only snapshot');
if (captureOnly && (mode !== 'plugin_only' || !statePath || requireState || fs.existsSync(statePath))) throw new Error('--capture-only needs a new plugin_only --state file');
const repositoryRoot = path.resolve(__dirname, '../../..');
for (const file of [statePath, process.env.RAG_EVAL_LLM_LOG].filter(Boolean)) {
  const real = fs.existsSync(file) ? fs.realpathSync(file) : path.join(fs.realpathSync(path.dirname(path.resolve(file))), path.basename(file));
  const relative = path.relative(repositoryRoot, real);
  if (!relative.startsWith('..' + path.sep) && relative !== '..') throw new Error('Snapshot/model log must be outside the repository');
}
if (process.env.RAG_EVAL_LLM_LOG && fs.existsSync(process.env.RAG_EVAL_LLM_LOG)) fs.chmodSync(process.env.RAG_EVAL_LLM_LOG, 0o600);
const privateWrite = (file, value) => { fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 }); fs.chmodSync(file, 0o600); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const stateDigest = statePath && fs.existsSync(statePath) ? digest(fs.readFileSync(statePath)) : null;
const llmUrl = String(process.env.RAG_EVAL_LLM_URL || '').replace(/\/+$/, '');
const embedUrl = String(process.env.RAG_EVAL_EMBED_URL || '').replace(/\/+$/, '');
if (!llmUrl) throw new Error('RAG_EVAL_LLM_URL is required');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const stats = { llmCalls: 0, llmAttempts: 0, llmMs: 0, llmFailures: 0, embedCalls: 0, embedFailures: 0,
  embedFixtureQueryCalls: 0, embedOtherInputCalls: 0, embedMs: 0 };
const fixtureQueries = new Set(fixture.questions.map(row => row.q));
const embeddingRequestModels = new Set();
const delta = before => Object.fromEntries(Object.keys(stats).map(key => [key, Math.round(stats[key] - before[key])]));

const callModel = async args => {
  const request = args[0] || {};
  const messages = (request.messages || request.prompt || []).map(m => ({ role: m.role === 'char' ? 'assistant' : m.role, content: String(m.content ?? '') }));
  const started = performance.now();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      stats.llmAttempts += 1;
      const response = await fetch(llmUrl + '/chat/completions', { method: 'POST',
        headers: { Authorization: `Bearer ${process.env.RAG_EVAL_LLM_KEY || ''}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: process.env.RAG_EVAL_LLM_MODEL, messages, temperature: 0, stream: false }),
        signal: AbortSignal.timeout(180000) });
      if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 200)}`);
      const body = await response.json();
      stats.llmCalls += 1; stats.llmMs += performance.now() - started;
      if (process.env.RAG_EVAL_LLM_LOG) fs.appendFileSync(process.env.RAG_EVAL_LLM_LOG, JSON.stringify({ messages, response: body.choices?.[0]?.message?.content || '',
        finish: body.choices?.[0]?.finish_reason || '', usage: body.usage || null }) + '\n', { mode: 0o600 });
      return { type: 'success', result: String(body.choices?.[0]?.message?.content || '') };
    } catch (error) {
      if (attempt === 2) { stats.llmFailures += 1; return { type: 'error', result: String(error.message || error) }; }
      await sleep(2000 * (attempt + 1));
    }
  }
};

// The fixture's preexisting scope registry binds this character/chat identity.
const chat = { id: 'unified-chat', chatId: 'unified-chat', name: 'RAG eval', message: [] };
fixture.turns.forEach(([user, assistant], index) => {
  chat.message.push({ role: 'user', chatId: `t${index + 1}-u`, data: user }, { role: 'char', chatId: `t${index + 1}-a`, data: assistant });
});
chat.messages = chat.message;

const live = argv.includes('--live');
const capturePublications = [];
let outputListener = null;
(async () => {
  const snapshot = await serverFixture({ mode, contextGlobals, snapshot: { chat },
    host: { runLLMModel: async (...args) => callModel(args),
      addRisuChatListener: async (_kind, handler) => { outputListener = handler; return true; } } });
  const results = [];
  try {
    let f = snapshot.f;
    f.control.onCall = callModel;
    if (embedUrl) {
      snapshot.hooks.externalFetch = async (url, init) => {
        const started = performance.now();
        // Count literal fixture-query inputs without persisting request text or keys.
        let isFixtureQuery = false;
        try {
          const body = JSON.parse(init.body), inputs = Array.isArray(body.input) ? body.input : [body.input];
          isFixtureQuery = inputs.length > 0 && inputs.every(text => fixtureQueries.has(text));
          if (typeof body.model === 'string') embeddingRequestModels.add(body.model);
        } catch (_) {}
        stats[isFixtureQuery ? 'embedFixtureQueryCalls' : 'embedOtherInputCalls'] += 1;
        try { const response = await fetch(url, init); if (!response.ok) stats.embedFailures += 1; return response; }
        catch (error) { stats.embedFailures += 1; throw error; }
        finally { stats.embedCalls += 1; stats.embedMs += performance.now() - started; }
      };
      await f.r.api.saveEmbeddingSettings({ enabled: true, provider: 'openai', url: embedUrl + '/embeddings',
        model: process.env.RAG_EVAL_EMBED_MODEL, key: process.env.RAG_EVAL_EMBED_KEY, maxRetries: 2 });
    }
    const captureStarted = performance.now();
    if (statePath && fs.existsSync(statePath) && mode === 'plugin_only') {
      snapshot.local.clear();
      for (const [key, value] of JSON.parse(fs.readFileSync(statePath, 'utf8'))) snapshot.local.set(key, value);
      f = await snapshot.restart();
      f.control.onCall = callModel;
      // A state captured before Micro vectors existed gets them stored here.
      if (!requireState) await f.r.api.retryPendingUnifiedVectors?.();
    } else {
      if (live) {
        const full = f.chat.message.slice();
        f.chat.message.length = 0;
        for (let index = 0; index < full.length; index += 2) {
          f.chat.message.push(full[index], full[index + 1]);
          f.chat.messages = f.chat.message;
          const turn = index / 2 + 1;
          outputListener?.({ char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0, messageIndex: f.chat.message.length - 1 });
          const turnStarted = Date.now();
          for (const deadline = Date.now() + 180000; Date.now() < deadline; await sleep(250)) {
            if (Number(f.r.api.getCaptureBackendState().lastMicroPublication?.turn || 0) >= turn) break;
          }
          const published = f.r.api.getCaptureBackendState().lastMicroPublication;
          const receipts = [...snapshot.local.keys()].filter(key => new RegExp(`:source-receipt-head:[^:]+:e\\d+:t${turn}$`).test(key)).length;
          process.stderr.write(`[live] turn ${turn} ${Date.now() - turnStarted}ms micro=${published?.turn}:${published?.status}:${published?.reason || ''} receipt=${receipts} llm=${stats.llmCalls}\n`);
          capturePublications.push({ turn, waitMs: Date.now() - turnStarted, observedTurn: published?.turn || null,
            status: published?.status || null, waitCompleted: Number(published?.turn || 0) >= turn });
        }
      }
      if (live && statePath && mode === 'plugin_only') privateWrite(statePath + '.live', [...snapshot.local]);
      // The live path already schedules canonical analysis; wait for it instead of failing.
      for (let round = 0, waits = 0; round < 12 && waits < 240;) {
        let result;
        try { result = await f.r.api.runManualColdStart(); }
        catch (error) {
          if (error?.code !== 'CANONICAL_HOST_REQUEST_PENDING') throw error;
          waits += 1; await sleep(5000); continue;
        }
        round += 1;
        if (!result?.completed) break;
      }
      await f.r.api.retryPendingUnifiedVectors?.();
      await sleep(3000);
      if (statePath && mode === 'plugin_only') privateWrite(statePath, [...snapshot.local]);
    }
    const captureMs = performance.now() - captureStarted;
    const activeEmbedding = await f.r.api.getEmbeddingSettings();
    if (requireState && embedUrl && (!activeEmbedding.enabled || activeEmbedding.model !== process.env.RAG_EVAL_EMBED_MODEL
      || activeEmbedding.url !== embedUrl + '/embeddings')) throw new Error('Snapshot embedding configuration does not match the requested provider/model');
    const pool = f.r.api.inspectMemoryGraphStore?.().resources || null;
    const preparationCalls = { ...stats };
    const pluginSource = f.r.source;
    const provenance = { pluginSha256: digest(pluginSource), snapshotSha256: stateDigest || (statePath ? digest(fs.readFileSync(statePath)) : null),
      fixtureSha256: digest(fs.readFileSync(fixturePath)), requireState, entrypoint, repeats, corpusIndex,
      configuredEmbeddingDimensions: activeEmbedding.dimensions || null };
    if (captureOnly) {
      const report = { schema: 'memory-suite.rag-eval-capture.v1', ...provenance, captureMs: Math.round(captureMs), capturePublications,
        embeddingRequestModels: [...embeddingRequestModels], calls: stats };
      if (option('--json')) privateWrite(option('--json'), report);
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      return;
    }
    const measure = async (question, round) => {
      const before = { ...stats }, started = performance.now();
      let recall = null, delivered = '', error = null, skipReason = null, injectionError = null;
      try {
        if (entrypoint === 'before-request') {
          f.chat.message.push({ role: 'user', chatId: 'eval-' + round + '-' + question.id, data: question.q });
          f.chat.messages = f.chat.message;
          try {
            const messages = [{ role: 'system', content: '너는 이야기의 진행자다.' },
              ...f.chat.message.slice(-5).map(m => ({ role: m.role === 'char' ? 'assistant' : 'user', content: m.data, chatId: m.chatId }))];
            const inputs = new Set(messages.map(m => m.content));
            const out = await f.control.hooks.beforeRequest(messages.map(m => ({ ...m })), 'model');
            delivered = (out || []).filter(m => m.role === 'system' && !inputs.has(m.content)).map(m => String(m.content || '')).join('\n');
            const runtime = f.r.api.getRuntime();
            recall = runtime.lastMemoryRecall;
            if (recall?.queryText !== question.q) recall = null;
            skipReason = runtime.lastMemoryInjectionMeta?.skipReason || null;
            injectionError = String(runtime.lastMemoryInjectionMeta?.error || '').match(/\bLIBRA_[A-Z0-9_]+\b/)?.[0] || null;
          } finally { f.chat.message.pop(); f.chat.messages = f.chat.message; }
        } else {
          recall = await f.r.api.previewUnifiedMemoryRecall(question.q);
          // Score the packet that can reach the consumer, never diagnostic excerpts.
          delivered = recall.unifiedExecution?.modelDispatchEligible === true ? String(recall.packet?.renderedText || '') : '';
        }
      } catch (err) { error = { code: err.code || err.name, reason: err.reason || null,
        message: /^LIBRA_[A-Z0-9_]+$/.test(err.message) ? err.message : 'recall_failed', resourceAccess: err.resourceAccess || null }; }
      const elapsedMs = Math.round(performance.now() - started);
      const execution = recall?.unifiedExecution || {};
      const resources = execution.diagnostics?.resourceAccess || execution.accessTrace?.resources || error?.resourceAccess || null;
      const stopReason = execution.stopReason || skipReason || error?.message || null;
      const found = question.expect.filter(needle => delivered.includes(needle));
      const row = { id: question.id, family: question.family, round, hit: found.length === question.expect.length,
        found, missing: question.expect.filter(needle => !found.includes(needle)), goldTurns: question.gold,
        items: (recall?.memories || []).length, elapsedMs, corpus: recall?.corpusRead?.mode || '',
        modelDispatchEligible: execution.modelDispatchEligible ?? null, queryComplete: execution.queryComplete ?? null,
        sourceCoverageComplete: execution.sourceCoverageComplete ?? null, coverage: execution.coverage || null,
        windowRead: recall?.windowRead || null, dispatchVerification: execution.dispatchVerification || null, stopReason, injectionError,
        budgetStopped: /budget|backpressure/i.test(String(stopReason) + ' ' + String(injectionError)) || Boolean(resources?.failure),
        calls: delta(before), resources, semantic: execution.diagnostics?.nativeSemantic || null,
        delivered, error, poolAfter: f.r.api.inspectMemoryGraphStore?.().resources || null };
      process.stderr.write(`[recall] ${round}:${question.id} ${elapsedMs}ms hit=${row.hit} stop=${stopReason || 'none'}\n`);
      return row;
    };
    // A user reads the response before the next request: give the runtime index the
    // same idle time (one cold recall schedules it), then measure steady-state recall.
    const cold = await measure(fixture.questions[0], 0);
    const coldRecallMs = cold.elapsedMs;
    const indexBuilds = [];
    if (corpusIndex === 'local-simulated') {
      // Settle startup source maintenance before a strict immutable publication.
      // Keep the real fresh-process observation above, including a rejection.
      await sleep(3000);
      for (let i = 0; i < indexRebuilds; i++) {
        const before = { ...stats }, started = performance.now();
        const build = await f.r.api.buildMemoryGraphCorpus();
        indexBuilds.push({ elapsedMs: Math.round(performance.now() - started), status: build.status,
          backend: build.persistenceBackend, reclamation: build.reclamation, calls: delta(before) });
        if (build.persistenceBackend !== 'indexeddb' || build.reclamation?.status !== 'completed') throw new Error('Local index build/reclamation failed');
      }
    }
    for (const deadline = Date.now() + 120000; corpusIndex === 'runtime' && Date.now() < deadline; await sleep(500)) {
      const status = f.r.api.inspectVolatileMemoryGraphCorpus?.();
      if (!status || status.available && !status.building && !status.scheduled) break;
    }
    // Micro vectors are stored in the background after publication / index builds.
    for (const deadline = Date.now() + 120000; Date.now() < deadline; await sleep(500)) {
      if (!f.r.api.inspectMicroRepresentationVectors?.().warming) break;
    }
    const runtimeIndex = f.r.api.inspectVolatileMemoryGraphCorpus?.() || null;
    const microVectors = f.r.api.inspectMicroRepresentationVectors?.() || null;
    const manifest = mode === 'plugin_only'
      ? JSON.parse([...snapshot.local].find(([key]) => key.endsWith(':manifest'))?.[1] || 'null')
      : snapshot.getManifest?.();
    const warmupCalls = delta(preparationCalls);
    for (let round = 1; round <= repeats; round += 1) for (const question of fixture.questions) results.push(await measure(question, round));
    const families = {};
    for (const row of results) { const b = families[row.family] ||= { questions: 0, hits: 0 }; b.questions += 1; b.hits += row.hit ? 1 : 0; }
    for (const b of Object.values(families)) b.hitRate = +(b.hits / b.questions).toFixed(3);
    const latency = results.map(row => row.elapsedMs).sort((a, b) => a - b);
    const report = { schema: 'memory-suite.rag-eval-report.v1', plugin: 'LIBRA end-to-end', fixture: path.basename(fixturePath), mode,
      ...provenance,
      llm: process.env.RAG_EVAL_LLM_MODEL, embedder: embedUrl ? process.env.RAG_EVAL_EMBED_MODEL : 'none (lexical)',
      canonicals: Object.keys(manifest?.memories || {}).length, captureMs: Math.round(captureMs),
      resourcePoolAfterCapture: pool && { sessions: pool.sessions, retainedBytes: pool.retainedBytes },
      coldRecallMs: Math.round(coldRecallMs), cold, capturePublications, preparationCalls, warmupCalls, runtimeIndex, microVectors, indexBuilds,
      hitRate: +(results.filter(row => row.hit).length / results.length).toFixed(3), families,
      latencyMs: { p50: (latency[Math.floor((latency.length - 1) / 2)] + latency[Math.floor(latency.length / 2)]) / 2,
        p95: latency[Math.ceil(latency.length * 0.95) - 1], max: latency.at(-1) },
      calls: { ...stats, llmMs: Math.round(stats.llmMs), embedMs: Math.round(stats.embedMs) },
      embeddingRequestModels: [...embeddingRequestModels],
      budgetStops: results.filter(row => row.budgetStopped).length, errors: results.filter(row => row.error).length,
      resourcePoolAfterQueries: f.r.api.inspectMemoryGraphStore?.().resources || null,
      misses: [...new Set(results.filter(row => !row.hit).map(row => row.id))], results };
    const jsonPath = option('--json');
    if (jsonPath) privateWrite(jsonPath, report);
    process.stdout.write(JSON.stringify({ ...report, cold: { ...cold, delivered: undefined }, results: undefined }, null, 2) + '\n');
  } finally { await snapshot.cleanup(); }
})().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
