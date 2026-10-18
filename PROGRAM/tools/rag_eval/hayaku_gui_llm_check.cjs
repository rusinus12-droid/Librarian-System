'use strict';
// HAYAKU GUI data check, step 1: produce real HAYAKU data through the four write paths with a
// REAL OpenAI-compatible model, in ONE chat, and save the resulting host state for the browser
// renderer (hayaku_gui_browser_render.cjs).
//
//   turns 1-4  packet-less history  -> recovery.coldStart (cold start, historical records)
//   turns 5-7  normal turns         -> canonical packet written by the main model
//   turn  8    packet-less reply    -> afterRequest automatic repair (one plugin model call)
//   turn  9    packet-less reply and a failing afterRequest repair -> missing turn
//              -> recovery.repairSelected (manual gap repair)
//
// Env: RAG_EVAL_LLM_URL (…/v1), OLLAMA_KEY or RAG_EVAL_LLM_KEY, RAG_EVAL_LLM_MODEL.
// Usage: node tools/rag_eval/hayaku_gui_llm_check.cjs --state out.json
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..', '..');
const { createHayakuRuntime } = require(path.join(ROOT, 'tests', 'fixtures', 'hayaku_runtime_harness.cjs'));
const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'rag_eval_ko_v1.json'), 'utf8'));

const LLM_URL = String(process.env.RAG_EVAL_LLM_URL || '').replace(/\/+$/, '');
const LLM_KEY = process.env.OLLAMA_KEY || process.env.RAG_EVAL_LLM_KEY || '';
const MODEL = process.env.RAG_EVAL_LLM_MODEL || 'deepseek-v4.1-flash:cloud';
const statePath = process.argv[process.argv.indexOf('--state') + 1];
if (!LLM_URL || !LLM_KEY || !process.argv.includes('--state')) { console.error('RAG_EVAL_LLM_URL, OLLAMA_KEY and --state are required'); process.exit(2); }

const calls = [];
let stage = 'setup';
const redact = s => String(s || '').split(LLM_KEY).join('[key]');
const callModel = async (messages, source) => {
  const body = JSON.stringify({ model: MODEL, temperature: 0, stream: false,
    messages: messages.map(m => ({ role: /^(system|user|assistant)$/.test(String(m.role)) ? m.role : (/^(char|bot|model)$/i.test(String(m.role)) ? 'assistant' : 'user'), content: String(m.content ?? '') })) });
  const row = { stage, source, ok: false, ms: 0 }; calls.push(row);
  const started = Date.now();
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(`${LLM_URL}/chat/completions`, { method: 'POST', body, signal: AbortSignal.timeout(240000),
        headers: { Authorization: `Bearer ${LLM_KEY}`, 'Content-Type': 'application/json' } });
      const raw = await response.text();
      if (!response.ok) { if (response.status >= 500 || response.status === 429) { await new Promise(r => setTimeout(r, 3000 * attempt)); continue; } throw new Error(`http_${response.status}:${redact(raw).slice(0, 160)}`); }
      row.ok = true; row.ms = Date.now() - started;
      return String(JSON.parse(raw)?.choices?.[0]?.message?.content ?? '');
    } catch (error) { if (attempt === 3) { row.ms = Date.now() - started; throw new Error(redact(error.message)); } await new Promise(r => setTimeout(r, 3000 * attempt)); }
  }
  throw new Error('model_unavailable');
};
const realResponder = async options => {
  try { return { type: 'success', result: await callModel(options?.messages || [], `runLLMModel:${options?.mode}`) }; }
  catch (error) { return { type: 'fail', result: String(error?.message || error) }; }
};
const user = (n, data) => ({ role: 'user', chatId: `u${n}`, id: `u${n}`, data, time: Date.now() });
const assistant = (n, data) => ({ role: 'assistant', chatId: `a${n}`, id: `a${n}`, data, time: Date.now() });
const SYSTEM = { role: 'system', content: '당신은 한국어 판타지 롤플레이의 내레이터입니다. 항구 마을을 배경으로, 사용자의 행동에 2~4문장의 한국어 서술로 답하세요.' };
const requestFor = chat => [SYSTEM, ...chat.message.map(m => ({ role: m.role, content: String(m.data), memo: m.chatId }))];
const records = async h => Array.from((await h.hayaku.ledger.inspect({ includeRecords: true })).records || []);
const coverage = async h => (await h.hayaku.recovery.status({ includeDebts: true, refreshDebts: true }))?.debt?.coverage || {};
const summaryOf = r => { try { return JSON.parse(r.raw)?.meta?.summary_memory?.summary || ''; } catch { return ''; } };

const turn = async (h, n, text, { reply } = {}) => {
  h.chat.message.push(user(n, text)); h.chat.messages = h.chat.message;
  const outgoing = await h.callBeforeRequest(requestFor(h.chat), 'model');
  const main = reply != null ? reply : await callModel(outgoing, 'main_model');
  const after = await h.callAfterRequest(main, 'model');
  h.chat.message.push(assistant(n, after)); h.chat.messages = h.chat.message;
  await h.callChatOutput({ char: h.character, chat: h.chat, characterIndex: 0, chatIndex: 0, messageIndex: h.chat.message.length - 1 });
  for (const started = Date.now(); Date.now() - started < 20000; await new Promise(r => setTimeout(r, 250))) {
    if ((await records(h)).some(r => Number(r.targetPairIndex || 0) === n && ['active', 'historical'].includes(r.recordState))) break;
  }
  return { replyHadPacket: /HAYAKU_STATE_PACKET_START/.test(main), returnedPacket: /HAYAKU_STATE_PACKET_START/.test(after) };
};

(async () => {
  const history = fixture.turns.slice(0, 4).flatMap(([u, a], i) => [user(i + 1, u), assistant(i + 1, a)]);
  const h = await createHayakuRuntime({ chatId: 'ko-gui', chatName: '항구 마을 이야기', characterName: '유나', messages: history,
    llmResponder: realResponder, afterRequestAutoRepair: true, backgroundAutoRepair: false, autoRepair: false,
    arguments: { hayaku_cold_start_batch_turns: '5' } });
  const report = { model: MODEL, stages: {} };
  try {
    stage = 'cold_start';
    const cold = await h.hayaku.recovery.coldStart({ resume: true });
    report.stages.coldStart = { ok: cold.ok, completed: cold.completed, packets: cold.packets, llmCalls: cold.llmCalls, reason: cold.reason };
    stage = 'canonical';
    report.stages.canonical = [];
    for (const n of [5, 6, 7]) report.stages.canonical.push({ turn: n, ...await turn(h, n, fixture.turns[n - 1][0]) });
    stage = 'auto_repair';
    report.stages.autoRepair = { turn: 8, ...await turn(h, 8, fixture.turns[7][0], { reply: fixture.turns[7][1] }) };
    stage = 'manual_repair_gap';
    h.setLlmResponder(async () => ({ type: 'success', result: 'not-a-packet (simulated failed afterRequest repair)' }));
    report.stages.gap = { turn: 9, ...await turn(h, 9, fixture.turns[8][0], { reply: fixture.turns[8][1] }) };
    h.setLlmResponder(realResponder);
    const before = await coverage(h);
    stage = 'manual_repair';
    const manual = await h.hayaku.recovery.repairSelected({ scopeKey: (await h.hayaku._test.currentChatScope()).key,
      targetTurns: (before.missingTurns || []).length ? before.missingTurns : [9], rows: before.rows });
    const after = await coverage(h);
    report.stages.manualRepair = { missingBefore: before.missingTurns, missingAfter: after.missingTurns, ok: manual.ok, completed: manual.completed, reason: manual.reason };
    const recs = await records(h);
    report.records = recs.filter(r => ['active', 'historical'].includes(r.recordState)).map(r => ({
      turn: Number(r.targetPairIndex || 0), source: r.captureSource, state: r.recordState, type: r.packetType, summary: summaryOf(r).slice(0, 160) }))
      .sort((a, b) => a.turn - b.turn);
    report.calls = calls.map(c => ({ stage: c.stage, source: c.source, ok: c.ok, ms: c.ms }));
    const dump = store => [...store.values.entries()];
    fs.writeFileSync(statePath, JSON.stringify({ chat: { id: h.chat.id, name: h.chat.name, message: h.chat.message }, character: { id: h.character.id, name: h.character.name },
      pluginStorage: dump(h.pluginStorage), safeLocalStorage: dump(h.safeLocalStorage), arguments: [...h.argumentsMap.entries()], report }, null, 1));
    console.log(JSON.stringify(report, null, 1));
  } finally { await h.dispose(); }
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
