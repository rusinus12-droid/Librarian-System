'use strict';
// Does GRADIA write with the recalled memory? Real-model grounding check.
//
// Real LIBRA (server_only, real HTTP/SQLite server, durable common index) supplies owner
// evidence through the unified read to the real GRADIA plugin. Every GRADIA stage call
// (SHADOW draft, AIDE patches) and a final main-model call on GRADIA's returned messages
// go to a real chat model. For each question the stored chat holds the answer only in
// memory (canonical facts and a later Micro correction); a question passes when the
// final answer contains the expected fact.
//   RAG_EVAL_LLM_URL (…/v1) / RAG_EVAL_LLM_KEY / RAG_EVAL_LLM_MODEL
// Node's built-in fetch ignores HTTPS_PROXY; run with NODE_USE_ENV_PROXY=1 behind a proxy.
// Usage: node tools/rag_eval/gradia_llm_grounding_eval.cjs [--json out.json]
const fs = require('node:fs');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { fixture } = require('../../tests/fixtures/libra_memory_graph_reader_fixture.cjs');
const { load } = require('../../tests/gradia/host.cjs');
const createBus = require('../../tests/fixtures/libra_gradia_read_bus.cjs');

const argv = process.argv.slice(2);
const jsonPath = argv.includes('--json') ? argv[argv.indexOf('--json') + 1] : '';
const llmUrl = String(process.env.RAG_EVAL_LLM_URL || '').replace(/\/+$/, '');
if (!llmUrl) throw new Error('RAG_EVAL_LLM_URL is required');
// Facts live only in LIBRA memory: turns 1-5 canonical artifact, turn 6 Micro claim.
const QUESTIONS = [
  { id: 'holder_now', q: '민아의 은빛 열쇠는 지금 누가 들고 있지?', expect: ['준호'] },
  { id: 'manager', q: '도서관은 어느 단체가 관리하지?', expect: ['기록회'] },
  { id: 'secret', q: '상자의 암호를 들은 사람은 누구였지?', expect: ['민아'] },
  { id: 'exception', q: '도서관에서 정숙 규칙의 예외가 되는 장소는 어디야?', expect: ['공연실'] },
  { id: 'relation', q: '민아는 지호를 어떻게 생각한다고 말했지?', expect: ['신뢰'] }
];

const chatModel = async messages => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(llmUrl + '/chat/completions', { method: 'POST',
        headers: { Authorization: `Bearer ${process.env.RAG_EVAL_LLM_KEY || ''}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: process.env.RAG_EVAL_LLM_MODEL, messages, temperature: 0, stream: false }) });
      if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 200)}`);
      return String((await response.json()).choices?.[0]?.message?.content || '');
    } catch (error) { if (attempt === 2) throw error; await new Promise(resolve => setTimeout(resolve, 3000)); }
  }
};

(async () => {
  const bus = createBus();
  const x = await fixture({ mode: 'server_only', hostOverrides: bus.api('libra') });
  const unload = [], stages = [];
  const results = [];
  try {
    const f = x.f, chat = f.chat, character = f.character;
    await f.r.api.buildMemoryGraphCorpus({ limit: 2 });
    const sdkFetch = async (url, init) => {
      if (url.startsWith(x.server.url + '/')) return await fetch(url, init);
      const body = JSON.parse(init.body);
      const content = await chatModel(body.messages);
      stages.push({ system: String(body.messages?.find(m => m.role === 'system')?.content || '').slice(0, 120), content,
        evidence: JSON.stringify(body).includes('owner_issued_evidence_bundle') });
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }) };
    };
    const g = await load({ testGlobals: { crypto: crypto.webcrypto }, api: { ...bus.api('serial_gradation_agents_for_rp'),
      pluginStorage: x.server.backend, getLocalPluginStorage: async () => x.server.backend,
      getArgument: async name => name.includes('url') ? x.server.url : name === 'mode' ? 'off' : undefined,
      getCurrentCharacterIndex: async () => 0, getCurrentChatIndex: async () => 0, getCharacterFromIndex: async () => character,
      getCharacter: async () => character, getChar: async () => character, getChat: async () => chat, getCurrentChat: async () => chat,
      getChatFromIndex: async () => chat, getDatabase: async () => ({ characters: [character], personas: [], selectedPersona: '', modules: [] }),
      nativeFetch: sdkFetch, onUnload: async fn => { unload.push(fn); return true; } } });
    const status = await g.plugin.connectLibReadOnly(x.server.url);
    if (status.state !== 'connected') throw new Error('GRADIA LIB read not connected: ' + JSON.stringify(status));
    await g.plugin.saveProviderPreset('eval', { provider: 'openai', url: 'https://eval.invalid/v1/chat/completions', key: 'eval-only',
      model: 'gpt-4o-mini-2024-07-18', request_format: 'chat_completions', context_window: 128000, max_tokens: 4096,
      reasoning_preset: 'off', reasoning_effort: 'none', timeout_ms: 180000, stream: false });
    await g.plugin.saveRuntimeSettings({ mode: 'normal', default_preset: 'eval', input_assist_mode: 'off', multi_pipeline_mode: 'lightweight',
      enable_shadow_act: true, enable_character_aide: true, enable_world_aide: true, enable_plot_aide: true, failure_mode: 'hard', lore_activation_mode: 'off' });
    const base = chat.message.slice();
    for (const question of QUESTIONS) {
      chat.message.length = 0; chat.message.push(...base, { role: 'user', chatId: 'q-' + question.id, data: question.q });
      chat.messages = chat.message;
      const messages = chat.message.map(row => ({ role: row.role === 'char' ? 'assistant' : row.role, content: row.data, messageId: row.chatId, chatId: row.chatId }));
      stages.length = 0;
      const started = performance.now();
      let output, error = '';
      try { output = await g.hooks.beforeRequest(messages, 'model'); } catch (failure) { error = String(failure?.code || failure?.message || failure); }
      const gradiaMs = performance.now() - started;
      const final = output ? await chatModel(output.map(row => ({ role: row.role === 'char' ? 'assistant' : row.role, content: String(row.content ?? '') }))) : '';
      const draft = stages[0]?.content || '';
      results.push({ id: question.id, q: question.q, expect: question.expect, error,
        stages: stages.length, stagesWithEvidence: stages.filter(stage => stage.evidence).length,
        draftHit: question.expect.every(needle => draft.includes(needle)), finalHit: question.expect.every(needle => final.includes(needle)),
        gradiaMs: Math.round(gradiaMs), draft: draft.slice(0, 400), final: final.slice(0, 400) });
    }
    chat.message.length = 0; chat.message.push(...base);
  } finally { for (const fn of unload.reverse()) { try { await fn(); } catch (_) {} } await x.cleanup(); }
  const report = { schema: 'memory-suite.rag-eval-report.v1', plugin: 'GRADIA grounding (real model)', model: process.env.RAG_EVAL_LLM_MODEL,
    draftHitRate: +(results.filter(r => r.draftHit).length / results.length).toFixed(3),
    finalHitRate: +(results.filter(r => r.finalHit).length / results.length).toFixed(3), results };
  if (jsonPath) fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
