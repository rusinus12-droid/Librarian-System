'use strict';
// Story clock step 2 (docs/gradia/STATE-AIDE-DESIGN-20261114.md §10): what GRADIA receives through
// the LIB read path carries the current story day and each lens note's day, in both storage modes,
// through the real RisuAI channel functions; GRADIA stores none of it.
const {test} = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto'), fs = require('node:fs'), path = require('node:path');
const {fixture} = require('./fixtures/libra_direct_memory_reader_fixture.cjs');
const {load} = require('./gradia/host.cjs');
const {waitFor} = require('./fixtures/libra_vm_harness.cjs');
const createHost = require('./fixtures/risu_plugin_channel_host.cjs');

const observeOwnerReadiness = source => {
  const seam = '    getCaptureBackendState() { return safeClone(LibraMemoryCore.getCaptureBackendState()); },';
  assert.ok(source.includes(seam));
  return source.replace(seam, `    ownerReadFixtureReady() {
      const s=LibraMemoryCore.state;
      return !s.microJobs.size && !s.receiptCaptureJobs.size && !s.storageWriteFence.size
        && !s.branchAuditInFlight.size && !s.timers.has('current_state_snapshot')
        && Number(s.snapshot?.refreshedAt||0)>=Number(s.lastMicroPublication?.at||0);
    },
` + seam);
};
const sources = {libra: fs.readFileSync(path.join(__dirname, '../plugins/LIBRA.js'), 'utf8'),
  serial_gradation_agents_for_rp: fs.readFileSync(path.join(__dirname, '../plugins/GRADIA.js'), 'utf8')};

for (const mode of ['plugin_only', 'server_only']) test(`${mode}: GRADIA's LIB read carries the current story day and lens note days`, {timeout: 180000}, async t => {
  const bus = createHost(sources), x = await fixture({mode, hostOverrides: bus.api('libra'), transformSource: observeOwnerReadiness});
  const unload = [], prompts = [];
  t.after(async () => { for (const fn of unload.reverse()) await fn(); await x.cleanup(); bus.dispose(); });
  const f = x.f, chat = f.chat, character = f.character;
  await waitFor(() => f.r.api.ownerReadFixtureReady(), 15000);
  // The user fixes pair 1 as day 3; the remaining pairs have no reports, so later days are estimates.
  const clock = await f.r.api.correctStoryClockTurn(1, {day: 3, date: '2026-04-01', timeOfDay: 'evening'});
  assert.equal(clock.entries.find(e => e.turn === 1).label, '이야기 3일째 · 저녁 · 2026-04-01');
  const lens = await f.r.api.createLens({name: '시계 IPC 렌즈', instruction: {goal: '몸 상태 기록'}, evidenceMode: 'strict',
    recall: {enabled: true, mode: 'recent', maxItems: 2, share: 100}});
  const quote = chat.message.find(row => row.chatId === 't1-a').data.slice(0, 60);
  f.control.onCall = async () => ({type: 'success', result: JSON.stringify({items: [{label: '단서', text: 'CLOCK_IPC_NOTE: 도서관에서 기록된 일.', quote, refs: ['t1-a']}]})});
  assert.equal((await f.r.core.runLensForRange(lens.lensId, {startTurn: 1, endTurn: 5})).acceptedCount, 1);
  const registry = await f.r.api.getLensRegistry(); await f.r.api.saveLensRegistry({...registry, recallSemantic: false});
  f.control.onCall = async () => { throw Error('read must not analyze memory'); };
  chat.message.push({role: 'user', chatId: 't7-u', data: '민아 은빛 열쇠의 현재 보관자는?'}); chat.messages = chat.message;
  const sdkFetch = async (url, init) => {
    if (x.server && url.startsWith(x.server.url + '/')) return fetch(url, init);
    const body = JSON.parse(init.body); prompts.push(body);
    const system = body.messages?.filter(m => m.role === 'system').map(m => m.content).join('\n') || '';
    const stage = (system.match(/(aide_\w+) patch JSON/) || [])[1];
    const content = stage ? JSON.stringify({schema: 'serial_gradation_agents_for_rp_draft_patch_v1', stage, ok: true, domain: {}, analysis: {summary: '근거 유지', constraints: [], risks: []}, edits: []})
      : '민아는 도서관의 은빛 열쇠를 확인하고 문 앞에서 조용히 기다렸다.';
    return {ok: true, status: 200, text: async () => JSON.stringify({choices: [{message: {content}, finish_reason: 'stop'}]})};
  };
  const localValues = new Map(), localStore = {getItem: async k => localValues.get(k) ?? null, setItem: async (k, v) => { localValues.set(k, v); return true; }, removeItem: async k => { localValues.delete(k); return true; }};
  const g = await load({testGlobals: {crypto: crypto.webcrypto}, api: {...bus.api('serial_gradation_agents_for_rp'),
    pluginStorage: x.server?.backend || localStore, getLocalPluginStorage: async () => x.server?.backend || localStore,
    getArgument: async name => name === 'mode' ? 'off' : name.includes('url') && x.server ? x.server.url : undefined,
    getCurrentCharacterIndex: async () => 0, getCurrentChatIndex: async () => 0, getCharacterFromIndex: async () => character, getCharacter: async () => character, getChar: async () => character,
    getChat: async () => chat, getCurrentChat: async () => chat, getChatFromIndex: async () => chat,
    getDatabase: async () => ({characters: [character], personas: [], selectedPersona: '', modules: []}), nativeFetch: sdkFetch, onUnload: async fn => { unload.push(fn); return true; }}});
  const status = await g.plugin.connectLibReadOnly(x.server?.url || '', mode === 'plugin_only' ? 'plugin_ipc' : 'unified_engine');
  assert.equal(status.state, 'connected', JSON.stringify(status));
  await g.plugin.saveProviderPreset('offline', {provider: 'openai', url: 'https://api.openai.com/v1/chat/completions', key: 'synthetic-only', model: 'gpt-4o-mini-2024-07-18', request_format: 'chat_completions', context_window: 128000, max_tokens: 2048, reasoning_preset: 'off', reasoning_effort: 'none', timeout_ms: 5000, stream: false});
  await g.plugin.saveRuntimeSettings({mode: 'normal', default_preset: 'offline', input_assist_mode: 'off', multi_pipeline_mode: 'lightweight', enable_shadow_act: true, enable_character_aide: true, enable_world_aide: true, enable_plot_aide: true, failure_mode: 'hard', lore_activation_mode: 'off'});
  const clockBefore = JSON.stringify(await f.r.api.getStoryClock());
  const messages = chat.message.map(row => ({role: row.role, content: row.data, messageId: row.chatId, chatId: row.chatId}));
  await g.hooks.beforeRequest(messages, 'model');
  assert.ok(prompts.length >= 1, JSON.stringify(g.plugin.getRuntime().last));
  const text = JSON.stringify(prompts);
  assert.ok(text.includes('CLOCK_IPC_NOTE') && text.includes('이야기 3일째 · 저녁 · 2026-04-01'), 'the lens note carries its day');
  // GRADIA's own evidence parser decides which owner lines reach its prompts; the owner contract is
  // the [STORY CLOCK] content line plus the structured lensEvidence.storyClock in the reply.
  const replies = bus.messages.filter(m => m.body?.kind === 'response' && JSON.stringify(m.body.result || {}).includes('[STORY CLOCK] 현재: 이야기 3일째(추정) · 저녁 · 2026-04-01'));
  assert.ok(replies.length, 'the host-routed reply carries the clock');
  assert.ok(replies.some(m => JSON.stringify(m.body.result).includes('libra.story_clock_delivery.v1')), 'the reply carries the structured clock');
  assert.equal(JSON.stringify(await f.r.api.getStoryClock()), clockBefore, 'reading changes no clock');
  const gradiaKeys = [...(x.server ? [] : localValues.keys())].filter(k => /story-clock|story_clock/i.test(k));
  assert.deepEqual(gradiaKeys, [], 'GRADIA stores no clock');
});
