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
// Usage: node tools/rag_eval/libra_e2e_eval.cjs [fixture.json] [--mode plugin_only|server_only] [--json out.json] [--state file]
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { serverFixture } = require('../../tests/fixtures/libra_server_runtime_fixture.cjs');

const argv = process.argv.slice(2);
const option = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const fixturePath = argv.find(value => value.endsWith('.json') && !['--json', '--state'].includes(argv[argv.indexOf(value) - 1]))
  || path.join(__dirname, '../../tests/fixtures/rag_eval_ko_v1.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const mode = option('--mode') || 'plugin_only';
const llmUrl = String(process.env.RAG_EVAL_LLM_URL || '').replace(/\/+$/, '');
const embedUrl = String(process.env.RAG_EVAL_EMBED_URL || '').replace(/\/+$/, '');
if (!llmUrl) throw new Error('RAG_EVAL_LLM_URL is required');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const stats = { llmCalls: 0, llmMs: 0, llmFailures: 0, embedCalls: 0, embedMs: 0 };

const callModel = async args => {
  const request = args[0] || {};
  const messages = (request.messages || request.prompt || []).map(m => ({ role: m.role === 'char' ? 'assistant' : m.role, content: String(m.content ?? '') }));
  const started = performance.now();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(llmUrl + '/chat/completions', { method: 'POST',
        headers: { Authorization: `Bearer ${process.env.RAG_EVAL_LLM_KEY || ''}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: process.env.RAG_EVAL_LLM_MODEL, messages, temperature: 0, stream: false }) });
      if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 200)}`);
      const body = await response.json();
      stats.llmCalls += 1; stats.llmMs += performance.now() - started;
      if (process.env.RAG_EVAL_LLM_LOG) fs.appendFileSync(process.env.RAG_EVAL_LLM_LOG, JSON.stringify({ messages, response: body.choices?.[0]?.message?.content || '',
        finish: body.choices?.[0]?.finish_reason || '', usage: body.usage || null }) + '\n');
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
let outputListener = null;
(async () => {
  const snapshot = await serverFixture({ mode, snapshot: { chat },
    host: { addRisuChatListener: async (_kind, handler) => { outputListener = handler; return true; } } });
  const results = [];
  try {
    let f = snapshot.f;
    f.control.onCall = callModel;
    if (embedUrl) {
      snapshot.hooks.externalFetch = async (url, init) => {
        const started = performance.now();
        try { return await fetch(url, init); } finally { stats.embedCalls += 1; stats.embedMs += performance.now() - started; }
      };
      await f.r.api.saveEmbeddingSettings({ enabled: true, provider: 'openai', url: embedUrl + '/embeddings',
        model: process.env.RAG_EVAL_EMBED_MODEL, key: process.env.RAG_EVAL_EMBED_KEY, maxRetries: 2 });
    }
    const captureStarted = performance.now();
    const statePath = option('--state');
    if (statePath && fs.existsSync(statePath) && mode === 'plugin_only') {
      for (const [key, value] of JSON.parse(fs.readFileSync(statePath, 'utf8'))) snapshot.local.set(key, value);
      f = await snapshot.restart();
      f.control.onCall = callModel;
      // A state captured before Micro vectors existed gets them stored here.
      await f.r.api.retryPendingUnifiedVectors?.();
    } else {
      if (live) {
        const full = f.chat.message.slice();
        f.chat.message.length = 0;
        for (let index = 0; index < full.length; index += 2) {
          f.chat.message.push(full[index], full[index + 1]);
          f.chat.messages = f.chat.message;
          const turn = index / 2 + 1;
          outputListener?.({ char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0, messageIndex: f.chat.message.length - 1 });
          for (const deadline = Date.now() + 180000; Date.now() < deadline; await sleep(250)) {
            if (Number(f.r.api.getCaptureBackendState().lastMicroPublication?.turn || 0) >= turn) break;
          }
        }
      }
      if (live && statePath && mode === 'plugin_only') fs.writeFileSync(statePath + '.live', JSON.stringify([...snapshot.local]));
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
      if (statePath && mode === 'plugin_only') fs.writeFileSync(statePath, JSON.stringify([...snapshot.local]));
    }
    const captureMs = performance.now() - captureStarted;
    const pool = f.r.api.inspectMemoryGraphStore?.().resources || null;
    // A user reads the response before the next request: give the runtime index the
    // same idle time (one cold recall schedules it), then measure steady-state recall.
    const coldStarted = performance.now();
    await f.r.api.previewUnifiedMemoryRecall(fixture.questions[0].q);
    const coldRecallMs = performance.now() - coldStarted;
    for (const deadline = Date.now() + 120000; Date.now() < deadline; await sleep(500)) {
      const status = f.r.api.inspectVolatileMemoryGraphCorpus?.();
      if (!status || status.available && !status.building && !status.scheduled) break;
    }
    // Micro vectors are stored in the background after publication / index builds.
    for (const deadline = Date.now() + 120000; Date.now() < deadline; await sleep(500)) {
      if (!f.r.api.inspectMicroRepresentationVectors?.().warming) break;
    }
    const runtimeIndex = f.r.api.inspectVolatileMemoryGraphCorpus?.() || null;
    const microVectors = f.r.api.inspectMicroRepresentationVectors?.() || null;
    const manifest = snapshot.getManifest?.() || f.getManifest();
    for (const question of fixture.questions) {
      const started = performance.now();
      const recall = await f.r.api.previewUnifiedMemoryRecall(question.q);
      const elapsedMs = performance.now() - started;
      const delivered = String(recall.packet?.renderedText || '') + '\n' + Array.from(recall.memories || [], row => String(row?.excerpt || row?.memory?.text || '')).join('\n');
      const found = question.expect.filter(needle => delivered.includes(needle));
      results.push({ id: question.id, family: question.family, hit: found.length === question.expect.length,
        items: (recall.memories || []).length, elapsedMs: Math.round(elapsedMs), corpus: recall.corpusRead?.mode || '',
        delivered: delivered.slice(0, 6000) });
    }
    const families = {};
    for (const row of results) { const b = families[row.family] ||= { questions: 0, hits: 0 }; b.questions += 1; b.hits += row.hit ? 1 : 0; }
    for (const b of Object.values(families)) b.hitRate = +(b.hits / b.questions).toFixed(3);
    const latency = results.map(row => row.elapsedMs).sort((a, b) => a - b);
    const report = { schema: 'memory-suite.rag-eval-report.v1', plugin: 'LIBRA end-to-end', fixture: path.basename(fixturePath), mode,
      llm: process.env.RAG_EVAL_LLM_MODEL, embedder: embedUrl ? process.env.RAG_EVAL_EMBED_MODEL : 'none (lexical)',
      canonicals: Object.keys(manifest?.memories || {}).length, captureMs: Math.round(captureMs),
      resourcePoolAfterCapture: pool && { sessions: pool.sessions, retainedBytes: pool.retainedBytes },
      coldRecallMs: Math.round(coldRecallMs), runtimeIndex, microVectors,
      hitRate: +(results.filter(row => row.hit).length / results.length).toFixed(3), families,
      latencyMs: { p50: latency[Math.floor(latency.length / 2)], max: latency.at(-1) },
      calls: { ...stats, llmMs: Math.round(stats.llmMs), embedMs: Math.round(stats.embedMs) },
      misses: results.filter(row => !row.hit).map(row => row.id), results };
    const jsonPath = option('--json');
    if (jsonPath) fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
    process.stdout.write(JSON.stringify({ ...report, results: undefined }, null, 2) + '\n');
  } finally { await snapshot.cleanup(); }
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
