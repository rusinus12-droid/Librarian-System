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
const timeoutMode = ['slots', 'runtime', 'default'].includes(process.env.GRADIA_EVAL_TIMEOUT_MODE) ? process.env.GRADIA_EVAL_TIMEOUT_MODE : 'runtime';
if (!llmUrl) throw new Error('RAG_EVAL_LLM_URL is required');
// Facts live only in LIBRA memory: turns 1-5 canonical artifact, turn 6 Micro claim.
const QUESTIONS = [
  { id: 'holder_now', q: '민아의 은빛 열쇠는 지금 누가 들고 있지?', expect: ['준호'] },
  { id: 'manager', q: '도서관은 어느 단체가 관리하지?', expect: ['기록회'] },
  { id: 'secret', q: '상자의 암호를 들은 사람은 누구였지?', expect: ['민아'] },
  { id: 'exception', q: '도서관에서 정숙 규칙의 예외가 되는 장소는 어디야?', expect: ['공연실'] },
  { id: 'relation', q: '민아는 지호를 어떻게 생각한다고 말했지?', expect: ['신뢰'] }
];

// RAG_EVAL_LLM_URL=fake answers instantly after RAG_EVAL_FAKE_DELAY_MS (pipeline timing probe).
// Returns { content, finish } so the plugin sees a real length stop instead of 'stop'.
const chatModel = async (messages, limits = {}) => {
  if (llmUrl === 'fake') {
    await new Promise(resolve => setTimeout(resolve, Number(process.env.RAG_EVAL_FAKE_DELAY_MS || 0)));
    const system = String(messages.find(m => m.role === 'system')?.content || '');
    const stage = (system.match(/(aide_\w+) patch JSON/) || [])[1];
    return { finish: 'stop', content: stage ? JSON.stringify({ schema: 'serial_gradation_agents_for_rp_draft_patch_v1', stage, ok: true, domain: {}, analysis: { summary: 'keep', constraints: [], risks: [] }, edits: [] })
      : '민아는 은빛 열쇠를 준호에게 건넸다.' };
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(llmUrl + '/chat/completions', { method: 'POST',
        headers: { Authorization: `Bearer ${process.env.RAG_EVAL_LLM_KEY || ''}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ temperature: 0, ...limits, model: process.env.RAG_EVAL_LLM_MODEL, messages, stream: false }),
        signal: AbortSignal.timeout(300000) });
      if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 200)}`);
      const choice = (await response.json()).choices?.[0] || {};
      return { content: String(choice.message?.content || ''), finish: String(choice.finish_reason || 'stop') };
    } catch (error) { if (attempt === 2) throw error; await new Promise(resolve => setTimeout(resolve, 3000)); }
  }
};

(async () => {
  const bus = createBus();
  const x = await fixture({ mode: 'server_only', hostOverrides: bus.api('libra') });
  const unload = [], stages = [];
  let requested = 0;
  const results = [];
  try {
    const f = x.f, chat = f.chat, character = f.character;
    await f.r.api.buildMemoryGraphCorpus({ limit: 2 });
    const sdkFetch = async (url, init) => {
      if (url.startsWith(x.server.url + '/')) return await fetch(url, init);
      const body = JSON.parse(init.body);
      requested += 1;
      // The plugin's own request (output budget, reasoning control, response format) goes to
      // the model unchanged; only the model id is replaced.
      const limits = Object.fromEntries(Object.entries(body).filter(([key]) => !['messages', 'model', 'stream'].includes(key)));
      const { content, finish } = await chatModel(body.messages, limits);
      stages.push({ system: String(body.messages?.find(m => m.role === 'system')?.content || '').slice(0, 120), content, finish,
        evidence: JSON.stringify(body).includes('owner_issued_evidence_bundle') });
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content }, finish_reason: finish }] }) };
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
      enable_shadow_act: true, enable_character_aide: true, enable_world_aide: true, enable_plot_aide: true, failure_mode: 'hard', lore_activation_mode: 'off',
      ...(timeoutMode === 'default' ? {} : { stage_timeout_ms: 300000 }) });
    // GRADIA_EVAL_TIMEOUT_MODE: 'runtime' (default) relies on the runtime stage_timeout_ms, which
    // untouched agent slots follow since 0.25.89; 'slots' also writes every slot's own timeout_ms
    // (the pre-0.25.89 workaround); 'default' sets neither (preset timeout, else the 300 s default).
    if (timeoutMode === 'slots') {
      await g.plugin.debugResolveStagePreset('shadow_act');
      const slots = await g.plugin.getAgentSlots(); for (const k of Object.keys(slots)) slots[k].timeout_ms = 300000; await g.plugin.saveAgentSlots(slots);
      const saved = await g.plugin.getAgentSlots();
      if (Object.values(saved).some(slot => Number(slot?.timeout_ms) !== 300000)) throw new Error('agent slot timeouts were not applied');
    }
    const stageTimeoutMs = (await g.plugin.debugResolveStagePreset('shadow_act')).timeoutMs;
    const base = chat.message.slice();
    for (const question of QUESTIONS) {
      chat.message.length = 0; chat.message.push(...base, { role: 'user', chatId: 'q-' + question.id, data: question.q });
      chat.messages = chat.message;
      const messages = chat.message.map(row => ({ role: row.role === 'char' ? 'assistant' : row.role, content: row.data, messageId: row.chatId, chatId: row.chatId }));
      stages.length = 0;
      const requestedFrom = requested;
      const started = performance.now();
      let output, error = '';
      try { output = await g.hooks.beforeRequest(messages, 'model'); }
      catch (failure) { error = String(failure?.code || failure?.message || failure) + ' ' + JSON.stringify(g.plugin.getRuntime()?.last || {}).slice(0, 600); }
      const gradiaMs = performance.now() - started;
      const final = output ? (await chatModel(output.map(row => ({ role: row.role === 'char' ? 'assistant' : row.role, content: String(row.content ?? '') })))).content : '';
      const draft = stages[0]?.content || '';
      results.push({ id: question.id, q: question.q, expect: question.expect, error,
        stages: stages.length, lengthStops: stages.filter(stage => stage.finish === 'length').length, stagesWithEvidence: stages.filter(stage => stage.evidence).length,
        draftHit: question.expect.every(needle => draft.includes(needle)), finalHit: question.expect.every(needle => final.includes(needle)),
        // Requests GRADIA dispatched for this question; more than the stage count means a stall or
        // length recovery resent a stage call (an abandoned request may still finish later).
        requests: requested - requestedFrom,
        stageTimeoutMs, gradiaMs: Math.round(gradiaMs), draft: draft.slice(0, 400), final: final.slice(0, 400) });
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
