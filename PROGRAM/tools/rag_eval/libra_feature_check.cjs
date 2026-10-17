'use strict';
// LIBRA feature check against a real chat model and a real embedding provider.
//
// Loads a plugin_only state captured by libra_e2e_eval.cjs (--state) and drives the
// shipped entry points a user reaches: the beforeRequest replacer (memory injection),
// the LLM / embedding connection tests, canonical regeneration (preview + adopt),
// the embedding vector rebuild and a manual scan. Each step reports ok, model and
// embedding calls, and, where the step rewrites memory, recall afterwards.
//   RAG_EVAL_LLM_URL / RAG_EVAL_LLM_KEY / RAG_EVAL_LLM_MODEL
//   RAG_EVAL_EMBED_URL / RAG_EVAL_EMBED_KEY / RAG_EVAL_EMBED_MODEL
// Node's built-in fetch ignores HTTPS_PROXY; run with NODE_USE_ENV_PROXY=1 behind a proxy.
// Usage: node tools/rag_eval/libra_feature_check.cjs --state file [--json out.json] [--only step,step]
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { serverFixture } = require('../../tests/fixtures/libra_server_runtime_fixture.cjs');

const argv = process.argv.slice(2);
const option = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '../../tests/fixtures/rag_eval_ko_v1.json'), 'utf8'));
const llmUrl = String(process.env.RAG_EVAL_LLM_URL || '').replace(/\/+$/, '');
const embedUrl = String(process.env.RAG_EVAL_EMBED_URL || '').replace(/\/+$/, '');
const statePath = option('--state');
if (!llmUrl || !embedUrl || !statePath) throw new Error('RAG_EVAL_LLM_URL, RAG_EVAL_EMBED_URL and --state are required');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const stats = { llmCalls: 0, embedCalls: 0 };

const callModel = async args => {
  const request = args[0] || {};
  const messages = (request.messages || request.prompt || []).map(m => ({ role: m.role === 'char' ? 'assistant' : m.role, content: String(m.content ?? '') }));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(llmUrl + '/chat/completions', { method: 'POST',
        headers: { Authorization: `Bearer ${process.env.RAG_EVAL_LLM_KEY || ''}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: process.env.RAG_EVAL_LLM_MODEL, messages, temperature: 0, stream: false }),
        signal: AbortSignal.timeout(180000) });
      if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 200)}`);
      stats.llmCalls += 1;
      return { type: 'success', result: String((await response.json()).choices?.[0]?.message?.content || '') };
    } catch (error) { if (attempt === 2) return { type: 'error', result: String(error.message || error) }; await sleep(2000 * (attempt + 1)); }
  }
};

const chat = { id: 'unified-chat', chatId: 'unified-chat', name: 'RAG eval', message: [] };
fixture.turns.forEach(([user, assistant], index) => {
  chat.message.push({ role: 'user', chatId: `t${index + 1}-u`, data: user }, { role: 'char', chatId: `t${index + 1}-a`, data: assistant });
});
chat.messages = chat.message;
const summarize = value => { try { return JSON.stringify(value, (k, v) => Array.isArray(v) && v.length > 4 ? `[${v.length}]` : typeof v === 'string' && v.length > 100 ? v.slice(0, 100) : v).slice(0, 300); } catch (_) { return String(value).slice(0, 300); } };

(async () => {
  const snapshot = await serverFixture({ mode: 'plugin_only', snapshot: { chat } });
  const steps = [];
  try {
    snapshot.hooks.externalFetch = async (url, init) => { stats.embedCalls += 1; return await fetch(url, init); };
    for (const [key, value] of JSON.parse(fs.readFileSync(statePath, 'utf8'))) snapshot.local.set(key, value);
    let f = await snapshot.restart();
    f.control.onCall = callModel;
    const api = () => f.r.api;
    await api().saveEmbeddingSettings({ enabled: true, provider: 'openai', url: embedUrl + '/embeddings',
      model: process.env.RAG_EVAL_EMBED_MODEL, key: process.env.RAG_EVAL_EMBED_KEY, maxRetries: 2 });
    await api().retryPendingUnifiedVectors();
    const questions = fixture.questions;
    const recallRate = async () => {
      let hits = 0;
      for (const q of questions) {
        const r = await api().previewUnifiedMemoryRecall(q.q);
        const text = String(r.packet?.renderedText || '') + (r.memories || []).map(m => String(m?.excerpt || m?.memory?.text || '')).join('\n');
        if (q.expect.every(n => text.includes(n))) hits += 1;
      }
      return +(hits / questions.length).toFixed(3);
    };
    const only = option('--only') ? new Set(option('--only').split(',')) : null;
    const step = async (name, fn, { recall = false } = {}) => {
      if (only && !only.has(name)) return null;
      const before = { ...stats }, started = performance.now(), row = { name };
      try { row.result = summarize(await fn()); row.ok = true; }
      catch (error) { row.ok = false; row.error = (String(error?.code || '') + ' ' + String(error?.message || error)).trim().slice(0, 300); }
      row.ms = Math.round(performance.now() - started);
      row.llmCalls = stats.llmCalls - before.llmCalls; row.embedCalls = stats.embedCalls - before.embedCalls;
      if (recall) row.recallRateAfter = await recallRate();
      steps.push(row);
      process.stderr.write(`[libra-check] ${name} ${row.ok ? 'ok' : 'FAIL ' + row.error} ${row.ms}ms llm=${row.llmCalls} embed=${row.embedCalls}\n`);
      return row;
    };
    await step('recall_baseline', async () => ({ recallRate: await recallRate() }));
    await step('test_embedding_provider', async () => {
      const r = await api().testLibraEmbeddingProvider();
      if (r?.ok === false || r?.status === 'failed') throw new Error(summarize(r));
      return r;
    });
    await step('test_llm_provider', async () => {
      const r = await api().testLibraLlmProvider('librarian');
      if (r?.ok === false) throw new Error(summarize(r));
      return r;
    });
    await step('test_risu_auxiliary_call', async () => {
      const r = await api().testRisuAuxiliaryCall();
      if (r?.ok === false) throw new Error(summarize(r));
      return r;
    });
    // The replacer RisuAI calls before the main model: memory must be injected.
    await step('before_request_injection', async () => {
      const hook = f.control.hooks.beforeRequest;
      if (typeof hook !== 'function') throw new Error('beforeRequest replacer not registered');
      let hits = 0; const misses = [], skips = {};
      for (const q of questions.filter(x => x.family !== 'name_number').slice(0, 6)) {
        // RisuAI appends the user's message to the chat before calling beforeRequest.
        f.chat.message.push({ role: 'user', chatId: 'q-' + q.id, data: q.q }); f.chat.messages = f.chat.message;
        try {
          const messages = [{ role: 'system', content: '너는 이야기의 진행자다.' },
            // RisuAI carries each chat message's chatId as memo (LIBRA's request provenance).
            ...f.chat.message.slice(-5).map(m => ({ role: m.role === 'char' ? 'assistant' : 'user', content: m.data, memo: m.chatId }))];
          const out = await hook(messages.map(m => ({ ...m })), 'model');
          const inputs = new Set(messages.map(m => m.content));
          const injected = (out || []).map(m => String(m.content || '')).filter(t => !inputs.has(t)).join('\n');
          if (q.expect.every(n => injected.includes(n))) hits += 1;
          else { misses.push(q.id); const meta = api().getRuntime?.()?.lastMemoryInjectionMeta || {}; skips[q.id] = meta.skipReason || (meta.injected ? 'injected_without_expected' : 'not_injected'); }
        } finally { f.chat.message.pop(); f.chat.messages = f.chat.message; }
      }
      if (!hits) throw new Error('nothing recalled into the request; ' + JSON.stringify(skips));
      return { hits, misses, skips };
    });
    await step('regenerate_canonical_preview_adopt', async () => {
      const job = await api().regenerateCanonicalMemory({ startTurn: 1 });
      if (job?.state !== 'awaiting_choice') throw new Error('regeneration state ' + summarize(job));
      const adopted = await api().resolveCanonicalCandidate({ jobId: job.jobId, decision: 'adopt' });
      if (!/^completed/.test(String(adopted?.state || ''))) throw new Error('adopt state ' + summarize(adopted));
      await api().retryPendingUnifiedVectors();
      return { jobState: job.state, adopted: adopted.state };
    }, { recall: true });
    await step('rebuild_embedding_vectors', async () => {
      const started = await api().rebuildEmbeddingVectors();
      let state = null;
      for (const deadline = Date.now() + 300000; Date.now() < deadline; await sleep(1000)) {
        state = await api().getEmbeddingRebuildState();
        if (!['running', 'queued', 'pending', 'rebuilding'].includes(String(state?.status || ''))) break;
      }
      if (/fail/i.test(String(state?.status || ''))) throw new Error('rebuild ' + summarize(state));
      return { started: summarize(started), status: state?.status, done: state?.done ?? state?.completed, failed: state?.failed };
    }, { recall: true });
    await step('scan_memory_now', async () => await api().scanMemoryNow());
    await step('restart_then_recall', async () => {
      f = await snapshot.restart(); f.control.onCall = callModel;
      await api().saveEmbeddingSettings({ enabled: true, provider: 'openai', url: embedUrl + '/embeddings',
        model: process.env.RAG_EVAL_EMBED_MODEL, key: process.env.RAG_EVAL_EMBED_KEY, maxRetries: 2 });
      return { micro: api().inspectMicroRepresentationVectors?.() };
    }, { recall: true });
  } finally { await snapshot.cleanup(); }
  const report = { schema: 'memory-suite.feature-check.v1', plugin: 'LIBRA', llm: process.env.RAG_EVAL_LLM_MODEL, embedder: process.env.RAG_EVAL_EMBED_MODEL,
    passed: steps.filter(s => s.ok).length, total: steps.length, steps };
  const jsonPath = option('--json');
  if (jsonPath) fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
