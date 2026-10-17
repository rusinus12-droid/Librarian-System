'use strict';
// GRADIA LLM feature check against a REAL chat model (end to end through the plugin's own
// provider adapter; nothing is faked except the RisuAI host).
//
// Plugin mode (no LIBRA server): provider test, model listing, beforeRequest draft pipeline
// (lightweight / heavyweight), afterRequest cleanup + output receipt listener, explicit input
// writer (rewriteInput, continueSceneWithInputAssist via a JSDOM UI), choice translation, and the
// user-intent OOC chat/compile. Server mode: the explicit input writer reading LIBRA evidence from
// a real LIBRA server (tests/fixtures/gradia_input_writer_unified_fixture.cjs, native=true).
//
//   RAG_EVAL_LLM_URL (…/v1, provider base) / RAG_EVAL_LLM_KEY / RAG_EVAL_LLM_MODEL
//   GRADIA_CHECK_PROVIDER (default ollama_cloud), NODE_USE_ENV_PROXY=1 behind a proxy.
// Usage: node tools/rag_eval/gradia_feature_llm_check.cjs [--only a,b] [--skip a,b] [--json out.json]
// Phases: provider, pipeline_light, pipeline_heavy, after_output, writer_plugin, ooc, writer_server
const fs = require('node:fs');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { JSDOM } = require('jsdom');
const { load } = require('../../tests/gradia/host.cjs');

const argv = process.argv.slice(2);
const opt = name => (argv.includes(name) ? argv[argv.indexOf(name) + 1] || '' : '');
const ALL = ['provider', 'pipeline_light', 'pipeline_heavy', 'after_output', 'writer_plugin', 'ooc', 'writer_server'];
const only = opt('--only') ? opt('--only').split(',') : ALL;
const skip = opt('--skip') ? opt('--skip').split(',') : [];
const want = phase => only.includes(phase) && !skip.includes(phase);
const jsonPath = opt('--json');
const llmBase = String(process.env.RAG_EVAL_LLM_URL || '').replace(/\/+$/, '');
const llmKey = String(process.env.RAG_EVAL_LLM_KEY || '');
const llmModel = String(process.env.RAG_EVAL_LLM_MODEL || '');
if (!llmBase || !llmKey || !llmModel) throw new Error('RAG_EVAL_LLM_URL, RAG_EVAL_LLM_KEY and RAG_EVAL_LLM_MODEL are required');
const PROVIDER = process.env.GRADIA_CHECK_PROVIDER || 'ollama_cloud';
const TIMEOUT = 300000;
const PRESET = { provider: PROVIDER, url: llmBase, key: llmKey, model: llmModel, request_format: 'chat_completions', context_window: 128000,
  max_tokens: 4096, reasoning_preset: 'off', reasoning_effort: 'none', timeout_ms: TIMEOUT, stream: false };
const redact = value => String(value ?? '').split(llmKey).join('[KEY]');
const snip = (value, n = 240) => redact(typeof value === 'string' ? value : JSON.stringify(value)).replace(/\s+/g, ' ').slice(0, n);
const wait = async (fn, label, ms = TIMEOUT) => { const at = Date.now(); while (Date.now() - at < ms) { const v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, 50)); } throw Error('WAIT_TIMEOUT: ' + label); };

// Every provider call goes over the network for real; the wrapper only measures it.
const calls = [];
const stageOf = body => {
  const system = (body.messages || []).filter(m => m.role === 'system').map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');
  const head = (system.match(/You are GRADIA [^.\n]{0,80}/) || system.match(/(aide_\w+|shadow_act)/) || [system.slice(0, 80)])[0];
  return head.replace(/\s+/g, ' ').slice(0, 90);
};
const meteredFetch = (isLlm = url => !url.startsWith('http://127.0.0.1')) => async (url, init = {}) => {
  if (!isLlm(String(url))) return await fetch(url, init);
  const started = performance.now();
  let body = {}; try { body = JSON.parse(init.body || '{}'); } catch (_) {}
  const row = { method: init.method || 'GET', path: new URL(url).pathname, stage: init.method === 'GET' ? 'GET' : stageOf(body), maxTokens: body.max_tokens ?? body.max_completion_tokens, ms: 0, status: 0, content: '' };
  calls.push(row);
  try {
    const response = await fetch(url, init);
    row.status = response.status; row.ms = Math.round(performance.now() - started);
    const raw = await response.text();
    try { const j = JSON.parse(raw); row.content = String(j.choices?.[0]?.message?.content ?? (Array.isArray(j.data) ? `[${j.data.length} models]` : raw)).slice(0, 2000); }
    catch (_) { row.content = raw.slice(0, 400); }
    row.finish = (() => { try { return JSON.parse(raw).choices?.[0]?.finish_reason || ''; } catch (_) { return ''; } })();
    return new Response(raw, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch (error) { row.ms = Math.round(performance.now() - started); row.error = String(error?.cause?.code || error?.message || error); throw error; }
};

// stage_timeout_ms is a legacy fallback migrated ONCE into the per-stage agent slots (on the first
// loadSettings); afterwards each slot's timeout_ms overrides preset.timeout_ms. Set the slots directly.
const setSlotTimeouts = async plugin => {
  await plugin.debugResolveStagePreset('shadow_act'); // forces the one-time slot migration
  const slots = await plugin.getAgentSlots();
  for (const id of Object.keys(slots)) slots[id] = { ...slots[id], timeout_ms: TIMEOUT };
  await plugin.saveAgentSlots(slots);
  const check = await plugin.getAgentSlots();
  if (Object.values(check).some(slot => slot.timeout_ms !== TIMEOUT)) throw new Error('slot timeout not applied');
};

const results = [];
const run = async (feature, trigger, mode, fn) => {
  const from = calls.length, started = performance.now();
  const entry = { feature, trigger, mode, ok: false, llmCalls: 0, ms: 0, evidence: '', error: '' };
  try { Object.assign(entry, await fn() || {}); }
  catch (error) { entry.ok = false; entry.error = redact(String(error?.code || '') + ' ' + String(error?.message || error)).trim().slice(0, 600); }
  const mine = calls.slice(from);
  entry.llmCalls = mine.filter(c => c.method !== 'GET').length;
  entry.ms = Math.round(performance.now() - started);
  entry.calls = mine.map(c => ({ stage: c.stage, maxTokens: c.maxTokens, status: c.status, ms: c.ms, finish: c.finish, error: c.error, content: snip(c.content, 160) }));
  results.push(entry);
  process.stderr.write(`[${entry.ok ? 'OK ' : 'FAIL'}] ${feature} (${mode}) calls=${entry.llmCalls} ${entry.ms}ms ${entry.ok ? snip(entry.evidence, 160) : entry.error}\n`);
  return entry;
};

const CHAT = () => ({ id: 'chat-1', name: 'check', message: [
  { role: 'user', chatId: 'u1', data: '나는 비 내리는 골목 끝의 낡은 서점 문을 연다.' },
  { role: 'char', chatId: 'a1', data: '종이 냄새가 훅 끼쳐 왔다. 계산대 뒤의 민아가 안경을 고쳐 쓰며 고개를 들었다. "문 닫을 시간인데요. 비 피하러 오셨어요?" 그녀의 손 옆에는 은빛 열쇠 하나가 놓여 있었다.' },
  { role: 'user', chatId: 'u2', data: '"열쇠가 예쁘네요. 무슨 열쇠예요?" 나는 젖은 우산을 접으며 묻는다.' }
] });
const CHARACTER = chat => ({ chaId: 'char-mina', name: '민아', desc: '골목 서점을 지키는 조용하고 경계심 많은 20대 서점 주인. 은빛 열쇠의 비밀을 숨기고 있다.',
  firstMessage: '비 오는 밤, 서점.', chats: [chat], chatPage: 0, lorebook: [], type: 'character' });

async function pluginHost() {
  const chat = CHAT(), character = CHARACTER(chat), listeners = {}, unloads = [], sent = [];
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'https://offline.invalid/' });
  const local = new Map(), device = { getItem: async k => local.get(k) ?? null, setItem: async (k, v) => { local.set(k, v); return true; }, removeItem: async k => { local.delete(k); return true; } };
  const nativeFetch = meteredFetch(() => true), sink = {};
  const g = await load({
    transformSource: source => source.replace('  const publicApi = Object.freeze({',
      '  __llmCheckSink.fns = { testProviderPreset, translateInputAssistReviewText, loadSettings };\n  const publicApi = Object.freeze({'),
    testGlobals: { __llmCheckSink: sink, crypto: crypto.webcrypto, Response, window: dom.window, Element: dom.window.Element, document: dom.window.document,
      getComputedStyle: dom.window.getComputedStyle.bind(dom.window), MutationObserver: dom.window.MutationObserver,
      requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
      navigator: { clipboard: { writeText: async () => {} }, userActivation: { isActive: true } } },
    api: { getLocalPluginStorage: async () => device, getArgument: async () => undefined,
      getCurrentCharacterIndex: async () => 0, getCurrentChatIndex: async () => 0, getCharacterFromIndex: async () => character,
      getCharacter: async () => character, getChar: async () => character, getChat: async () => chat, getCurrentChat: async () => chat,
      getChatFromIndex: async () => chat, getDatabase: async () => ({ characters: [character], personas: [], selectedPersona: '', modules: [] }),
      nativeFetch, fetch: nativeFetch, showContainer: async () => {}, hideContainer: async () => {}, sendChat: async v => { sent.push(v); return true; },
      addRisuChatListener: async (name, fn) => { listeners[name] = fn; }, removeRisuChatListener: async () => {},
      onUnload: async fn => { unloads.push(fn); return true; } } });
  await g.plugin.saveProviderPreset('check', PRESET);
  const settings = async extra => await g.plugin.saveRuntimeSettings({ mode: 'normal', default_preset: 'check', input_assist_mode: 'off',
    multi_pipeline_mode: 'lightweight', enable_shadow_act: true, enable_character_aide: true, enable_world_aide: true, enable_plot_aide: true,
    failure_mode: 'hard', lore_activation_mode: 'off', input_assist_lore_activation_mode: 'off', stage_timeout_ms: TIMEOUT, ...extra });
  await settings({});
  await setSlotTimeouts(g.plugin);
  const doc = dom.window.document;
  const button = label => [...doc.querySelectorAll('button')].find(n => n.textContent.trim() === label);
  return { ...g, chat, character, listeners, sent, dom, doc, button, settings, check: sink.fns,
    close: async () => { try { await g.plugin.closeSettingsGui(); } catch (_) {} for (const fn of unloads.reverse()) { try { await fn(); } catch (_) {} } dom.window.close(); } };
}
const requestMessages = chat => chat.message.map(row => ({ role: row.role === 'char' ? 'assistant' : row.role, content: row.data, chatId: row.chatId, messageId: row.chatId }));

async function pipeline(h, heavy) {
  await h.settings({ multi_pipeline_mode: heavy ? 'heavyweight' : 'lightweight' });
  const plan = h.plugin.debugTotalCallPlan({ multiPipelineMode: heavy ? 'heavyweight' : 'lightweight', enableShadowAct: true, enableCharacterAide: true, enableWorldAide: true, enablePlotAide: true });
  const input = requestMessages(h.chat);
  const before = JSON.stringify(input);
  const output = await h.hooks.beforeRequest(input, 'model');
  const injection = h.plugin.getLastInjection();
  const last = h.plugin.getRuntime()?.last || {};
  const trace = h.plugin.getStageTrace();
  const stagesOk = trace.filter(t => !t.skipped).map(t => `${t.stage}:${t.ok ? 'ok' : 'FAIL'}`);
  const injected = Array.isArray(output) && !!injection && output.some(m => String(m.content ?? '').includes(injection.slice(0, 200)));
  const telemetry = h.plugin.getCallTelemetry();
  const ok = last.ok === true && injected && trace.filter(t => !t.skipped).every(t => t.ok) && JSON.stringify(output) !== before;
  return { ok, plan: { expectedDraftCalls: plan.baseDraftCalls, stages: plan.draftStages },
    evidence: `last.ok=${last.ok} stages=[${stagesOk.join(',')}] injected=${injected} overlayChars=${injection.length} telemetryCalls=${telemetry?.actualLogicalCalls} draft="${snip(h.plugin.getFinalDraft(), 140)}"`,
    error: ok ? '' : `last=${snip(last, 400)} trace=${snip(trace.map(t => ({ stage: t.stage, ok: t.ok, reason: t.reason })), 400)}`, output };
}

(async () => {
  let h;
  try {
    if (['provider', 'pipeline_light', 'pipeline_heavy', 'after_output', 'writer_plugin', 'ooc'].some(want)) h = await pluginHost();
    if (want('provider')) {
      await run('testProviderPreset', 'GUI connection test (internal testProviderPreset)', 'plugin', async () => {
        const result = await h.check.testProviderPreset(PRESET);
        const reply = String(result?.content ?? result?.text ?? result?.raw ?? JSON.stringify(result));
        return { ok: !!reply.trim(), evidence: `model=${result?.model || ''} reply="${snip(reply, 120)}"` };
      });
      await run('listProviderModels', 'plugin.listProviderModels (GET models)', 'plugin', async () => {
        const models = await h.plugin.listProviderModels('check', { force: true });
        return { ok: models.length > 0, evidence: `${models.length} models; includes ${llmModel}=${models.some(m => m.id === llmModel)}; e.g. ${models.slice(0, 3).map(m => m.id).join(',')}` };
      });
    }
    let lightOutput = null;
    if (want('pipeline_light')) {
      await run('beforeRequest draft pipeline (lightweight)', "hooks.beforeRequest(messages,'model')", 'plugin', async () => {
        const res = await pipeline(h, false); lightOutput = res.output; delete res.output; return res;
      });
    }
    if (want('pipeline_heavy')) {
      await run('beforeRequest draft pipeline (heavyweight)', "hooks.beforeRequest(messages,'model')", 'plugin', async () => {
        const res = await pipeline(h, true); delete res.output; return res;
      });
      await h.settings({ multi_pipeline_mode: 'lightweight' });
    }
    if (want('after_output')) {
      await run('afterRequest cleanup + output receipt', "hooks.afterRequest(response,'model'); chat 'output' listener", 'plugin', async () => {
        let mainReply = '';
        if (lightOutput) { // final main-model call on GRADIA's returned messages, like the host would make
          const fetchMain = meteredFetch(() => true);
          const response = await fetchMain(llmBase + '/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${llmKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: llmModel, stream: false, temperature: 0.7, messages: lightOutput.map(m => ({ role: m.role === 'char' ? 'assistant' : m.role, content: String(m.content ?? '') })) }) });
          mainReply = String((await response.json()).choices?.[0]?.message?.content || '');
        }
        const planted = `<thinking>PLAN: hidden beat list</thinking>\nKey beats: 1) reveal 2) hesitate\n### 응답\n${mainReply || '민아는 열쇠를 쥔 손을 거두었다.'}`;
        const cleaned = await h.hooks.afterRequest(planted, 'model');
        const cleanedObj = await h.hooks.afterRequest({ role: 'assistant', content: '<reasoning>secret</reasoning>본문만 남는다.' }, 'model');
        const passthrough = await h.hooks.afterRequest('<thinking>x</thinking>keep', 'memory');
        const stripped = !/PLAN: hidden|Key beats|<thinking>/i.test(String(cleaned)) && String(cleaned).trim().length > 0;
        const objOk = cleanedObj?.content === '본문만 남는다.';
        const lastMain = h.plugin.getRuntime()?.lastMainResponse?.content || '';
        // output listener: receipts are keyed by (character, chat, messageId); verify via recent-turn eligibility.
        const listener = h.listeners.output;
        const reply = { role: 'char', chatId: 'a2', data: String(cleaned) };
        h.chat.message.push(reply);
        const beforeElig = await h.plugin.debugNativeRecentContext('', null, 4);
        if (listener) await listener({ chat: h.chat, messageIndex: h.chat.message.length - 1, char: h.character, characterIndex: 0 });
        const afterElig = await h.plugin.debugNativeRecentContext('', null, 4);
        h.chat.message.pop();
        const ok = stripped && objOk && passthrough === '<thinking>x</thinking>keep' && typeof listener === 'function';
        return { ok, evidence: `mainReply="${snip(mainReply, 100)}" cleaned="${snip(cleaned, 100)}" objOk=${objOk} nonModelPassthrough=${passthrough === '<thinking>x</thinking>keep'} lastMainResponseSet=${!!lastMain} listener=${typeof listener} eligibility before=${snip(beforeElig.turnEligibility, 160)} after=${snip(afterElig.turnEligibility, 160)}` };
      });
    }
    if (want('writer_plugin')) {
      await h.settings({ input_assist_mode: 'user_focus', writing_mode: 'rp', input_assist_target_chars: 500 });
      let firstChoice = '';
      await run('Input writer: rewriteInput (RP action choices)', 'plugin.rewriteInput(content)', 'plugin', async () => {
        const original = '열쇠에 대해 더 캐묻는다.';
        const returned = await h.plugin.rewriteInput(original);
        const last = h.plugin.getRuntime().lastInputAssist || {};
        const choices = last.authorChoices || [];
        firstChoice = choices[0]?.brief || '';
        return { ok: last.ok === true && choices.length >= 2 && returned === original, evidence: `returned===original:${returned === original} mode=${last.effectiveMode} choices=${choices.length} A="${snip(choices[0]?.brief, 120)}" B="${snip(choices[1]?.brief, 80)}"`, error: last.ok ? '' : snip(last.reason, 300) };
      });
      await run('Input writer: translateInputAssistReviewText', 'picker 번역 button (internal)', 'plugin', async () => {
        const settings = await h.check.loadSettings();
        const out = await h.check.translateInputAssistReviewText(firstChoice || '"그 열쇠, 어디에 쓰는 거예요?" 나는 조심스럽게 묻는다.', settings, 'english');
        return { ok: !!out && /[a-z]/i.test(out) && !/[가-힣]{4,}/.test(out), evidence: `en="${snip(out, 160)}"` };
      });
      await run('Input writer: continueSceneWithInputAssist (composer→choice→delivery)', 'plugin.continueSceneWithInputAssist + UI clicks', 'plugin', async () => {
        const pending = h.plugin.continueSceneWithInputAssist();
        const editor = await wait(() => h.doc.querySelector('textarea[placeholder]'), 'composer', 10000);
        editor.value = '민아에게 열쇠를 보여 달라고 부탁한다.';
        h.button('진행').click();
        const cards = await wait(() => { const s = h.plugin.getInputAssistSendStatus(); if (s?.phase === 'error' || s?.phase === 'cancelled') throw Error('WRITER_FAILED ' + snip(s, 300)); const c = [...h.doc.querySelectorAll('[data-input-choice-card]')]; return c.length ? c : null; }, 'choice picker');
        cards[0].querySelector('.btn--primary').click();
        await wait(() => h.button('바로 전송'), 'delivery picker', 10000);
        h.button('바로 전송').click();
        const done = await pending;
        const last = h.plugin.getLastInputAssist() || {};
        return { ok: done === true && h.sent.length === 1 && !!String(h.sent[0]).trim(), evidence: `cards=${cards.length} sent="${snip(h.sent[0], 140)}" deliverySource=${last.deliverySource} status=${snip(h.plugin.getInputAssistSendStatus(), 120)}` };
      });
      await h.settings({ input_assist_mode: 'off' });
    }
    if (want('ooc')) {
      await run('User-intent OOC chat', 'plugin.runUserIntentOoc(message)', 'plugin', async () => {
        const r1 = await h.plugin.runUserIntentOoc('다음 장면에서 민아가 열쇠의 비밀을 바로 털어놓지 말고, 망설이며 화제를 돌리게 해줘. 분위기는 잔잔하게.');
        return { ok: !!String(r1.reply || '').trim(), evidence: `target=${r1.targetStage} ready=${r1.readyToCompile} reply="${snip(r1.reply, 160)}"` };
      });
      await run('User-intent OOC compile', 'plugin.compileUserIntentOoc()', 'plugin', async () => {
        const out = await h.plugin.compileUserIntentOoc();
        const state = h.plugin.getUserIntentOoc();
        const instruction = out?.instruction || out?.compiled || out?.text || state?.compiled?.instruction || '';
        return { ok: !!JSON.stringify(out).match(/[가-힣a-z]{6}/i) && out?.ok !== false, evidence: `keys=${Object.keys(out || {}).join(',')} instr="${snip(instruction || out, 200)}"` };
      });
      await run('Creative-direction OOC alias', 'plugin.runCreativeDirectionOoc(message)', 'plugin', async () => {
        const r = await h.plugin.runCreativeDirectionOoc('좋아, 그 방향으로 확정해줘.');
        return { ok: !!String(r.reply || '').trim(), evidence: `ready=${r.readyToCompile} reply="${snip(r.reply, 140)}"` };
      });
    }
    if (h) { await h.close(); h = null; }
    if (want('writer_server')) await writerServer();
  } finally { if (h) await h.close(); }
  const report = { schema: 'gradia-feature-llm-check.v1', model: llmModel, provider: PROVIDER, totalLlmCalls: calls.filter(c => c.method !== 'GET').length,
    passed: results.filter(r => r.ok).length, total: results.length, results };
  if (jsonPath) fs.writeFileSync(jsonPath, redact(JSON.stringify(report, null, 2)));
  process.stdout.write(redact(JSON.stringify(report, null, 2)) + '\n');
  process.exit(0);
})().catch(error => { console.error(redact(error?.stack || error)); process.exit(1); });

async function writerServer() {
  const { fixture } = require('../../tests/fixtures/gradia_input_writer_unified_fixture.cjs');
  const after = [];
  try {
    const f = await fixture({ after: fn => after.push(fn) }, { native: true, writingMode: 'novel' });
    await f.nativeHost.f.r.api.buildMemoryGraphCorpus({ limit: 2 });
    // The fixture's model transport is synthetic; route every model prompt to the real model
    // through the fixture's onModel hook (prompt body is exactly what GRADIA built).
    const meter = meteredFetch(() => true);
    f.controls.onModel = async (n, body) => {
      const response = await meter(llmBase + '/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${llmKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, model: llmModel, stream: false }) });
      f.controls.output = String((await response.json()).choices?.[0]?.message?.content || '');
    };
    await f.host.plugin.saveProviderPreset('writer', { provider: 'openai', url: 'https://api.openai.com/v1/chat/completions', key: 'synthetic-only',
      model: 'gpt-4o-mini-2024-07-18', request_format: 'chat_completions', context_window: 128000, max_tokens: 4096, reasoning_preset: 'off',
      reasoning_effort: 'none', timeout_ms: TIMEOUT, stream: false });
    await setSlotTimeouts(f.host.plugin);
    await run('Input writer with LIBRA evidence (novel 3-perspective)', 'continueSceneWithInputAssist + UI, LIBRA server_only', 'server', async () => {
      const { pending } = await f.start('민아와 준호, 은빛 열쇠의 현재 보관 상황을 참고해 다음 입력을 제안해 줘.');
      const cards = await wait(() => { const s = f.host.plugin.getInputAssistSendStatus(); if (s?.phase === 'error' || s?.phase === 'cancelled') throw Error('WRITER_FAILED ' + snip(s, 300)); const c = [...f.document.querySelectorAll('[data-input-choice-card]')]; return c.length ? c : null; }, 'choice picker');
      const texts = cards.map(c => c.textContent.replace(/\s+/g, ' ').trim());
      cards[0].querySelector('.btn--primary').click();
      await wait(() => f.button('바로 전송'), 'delivery picker', 10000);
      const done = await f.done(pending, '바로 전송');
      const evidenceInPrompt = JSON.stringify(f.prompts[0] || {}).includes('owner_issued_evidence_bundle');
      const mentions = /준호/.test(texts.join(' '));
      return { ok: done === true && f.sent.length === 1 && evidenceInPrompt, evidence: `evidenceInPrompt=${evidenceInPrompt} cards=${cards.length} mentions준호=${mentions} sent="${snip(f.sent[0], 160)}" libraCaptures=${f.queries()}` };
    });
  } finally { for (const fn of after.reverse()) { try { await fn(); } catch (_) {} } }
}
