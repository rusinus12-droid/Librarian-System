'use strict';
// 화술·대화 AIDE (aide_dialogue): 사람다운 화술·대사 검증 및 메아리 문답("이야?"/"이야.") 차단 계약 시험.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./host.cjs');

const BLOCK = '[DIALOGUE & SPEECHCRAFT (화술·대화)';
const CHAT = { id: 'chat-dlg', chatId: 'chat-dlg', name: 'dlg', message: [
  { role: 'user', chatId: 'u1', data: '하연에게 다가간다.' },
  { role: 'assistant', chatId: 'a1', data: '민아가 물었다. "오늘 진짜 가는 거야?" 하연이 답했다. "응, 진짜 가는 거야."' }
] };
const CHARACTER = { chaId: 'c-dlg', name: '하연', chats: [CHAT], chatPage: 0, lorebook: [] };
const ECHO_QUOTE = '오늘 진짜 오는 거야?';
const DRAFT = '하연은 소파에 기대며 말했다. "오늘 진짜 오는 거야?" 민아가 고개를 끄덕였다. "응, 오늘 진짜 오는 거야."';
const systemOf = body => (body.messages || []).filter(m => m.role === 'system').map(m => m.content).join('\n');
const stageOf = body => (systemOf(body).match(/"stage":\s*"([^"]+)"/) || [])[1] || '';

const DIALOGUE_REPORT = {
  dialogue_repairs: [
    { character: '하연', draft_quote: ECHO_QUOTE, issue: 'echo_loop',
      replacement: '빈손으로 오면 문 안 열어 줄 거다?', reason: '메아리 문답을 우회적 도발로 바꿈' },
    { character: '민아', draft_quote: '초안에 없는 대사', issue: 'flat_filler',
      replacement: '글쎄.', reason: '지어낸 인용은 버려져야 함' }
  ]
};

const pipeline = async (runtime = {}, loadOptions = {}) => {
  const prompts = [];
  const h = await load({ ...loadOptions,
    api: {
      getCharacter: async () => CHARACTER, getChar: async () => CHARACTER, getCharacterFromIndex: async () => CHARACTER,
      getCurrentCharacterIndex: async () => 0, getCurrentChatIndex: async () => 0, getChatFromIndex: async () => CHAT,
      getDatabase: async () => ({ personas: [], selectedPersona: '', modules: [], characters: [CHARACTER] }),
      nativeFetch: async (_url, init) => {
        const body = JSON.parse(init.body);
        prompts.push(body);
        const system = systemOf(body), stage = stageOf(body);
        const analysis = system.includes('serial_gradation_agents_for_rp_analysis_');
        const patch = system.includes('serial_gradation_agents_for_rp_draft_patch_v1');
        const base = { ok: true, analysis: { summary: 'checked', constraints: [], risks: [] }, domain: {},
          rewrite_directives: [], do_not_reveal: [], pov_limits: [], beats: [] };
        let content;
        if (analysis) content = JSON.stringify({ schema: 'serial_gradation_agents_for_rp_analysis_v4', stage, ...base });
        else if (patch) content = JSON.stringify({ schema: 'serial_gradation_agents_for_rp_draft_patch_v1', stage, ...base,
          edits: [],
          ...(stage === 'aide_character' ? DIALOGUE_REPORT : {}) });
        else content = DRAFT;
        return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }) };
      }
    } });
  await h.plugin.saveProviderPreset('offline', { provider: 'custom', url: 'https://offline.invalid/v1/chat/completions',
    key: 'synthetic', model: 'offline-model', context_window: 128000, max_tokens: 4096, timeout_ms: 5000, stream: false });
  await h.plugin.saveRuntimeSettings({ mode: 'normal', default_preset: 'offline', input_assist_mode: 'off',
    multi_pipeline_mode: 'lightweight', failure_mode: 'hard', lore_activation_mode: 'off',
    writing_mode: 'rp', rp_impersonation_scope: 'persona',
    enable_shadow_act: true, enable_character_aide: true, enable_world_aide: false, enable_plot_aide: false, ...runtime });
  const slots = await h.plugin.getAgentSlots();
  const enabled = runtime.enable_dialogue_aide !== false;
  await h.plugin.saveAgentSlots({ ...slots, aide_dialogue: { ...(slots.aide_dialogue || {}), enabled } });
  return { h, prompts };
};
const runTurn = async (h, input = '하연을 바라본다.') =>
  h.hooks.beforeRequest([{ role: 'user', messageId: 'u-current', chatId: 'u-current', content: input }], 'model');
const readingsOf = h => Object.values(h.plugin.getRuntime().dialogueReadings || {});

test('화술·대화 AIDE는 메아리 문답을 패킷에 탐지하고, 초안에 있는 수정만 판독에 남기며 없는 인용은 버린다', async () => {
  const { h, prompts } = await pipeline({ enable_dialogue_aide: true });
  await runTurn(h);
  const blocks = prompts.filter(body => systemOf(body).includes(BLOCK));
  assert.ok(blocks.length >= 2, 'dialogue block reaches SHADOW and host AIDE');
  const host = prompts.find(body => stageOf(body) === 'aide_character');
  const hostText = systemOf(host);
  assert.ok(hostText.includes('OUTPUT: add a top-level "dialogue_repairs" array'), 'host asks for dialogue_repairs');
  assert.ok(hostText.includes('Echo-loop pair:'), 'recent echo-loop pair is flagged in packet');

  const readings = readingsOf(h);
  assert.equal(readings.length, 1);
  assert.equal(readings[0].repairs.length, 1, 'only grounded quote survives');
  assert.equal(readings[0].repairs[0].draftQuote, ECHO_QUOTE);
  assert.equal(readings[0].repairs[0].issue, 'echo_loop');
  assert.equal(readings[0].repairs[0].applied, false, 'no edits applied so applied is false');
  assert.equal(readings[0].dropped.length, 1, 'hallucinated quote is dropped');
  assert.equal(readings[0].dropped[0].reason, 'draft_quote_not_in_draft');
});

test('화술·대화 AIDE가 꺼져 있으면 프롬프트·스키마·판독에 흔적이 없다', async () => {
  const { h, prompts } = await pipeline({ enable_dialogue_aide: false });
  await runTurn(h);
  assert.equal(prompts.filter(body => systemOf(body).includes('DIALOGUE & SPEECHCRAFT')).length, 0);
  assert.equal(prompts.filter(body => systemOf(body).includes('dialogue_repairs')).length, 0);
  assert.equal(readingsOf(h).length, 0);
});

test('화술·대화 AIDE는 RP 페르소나 보호·소설·문장화 모드 규칙을 따른다', async () => {
  const rp = await pipeline({ enable_dialogue_aide: true, writing_mode: 'rp', rp_impersonation_scope: 'persona' });
  await runTurn(rp.h);
  assert.ok(rp.prompts.map(systemOf).join('\n').includes('apply to NPCs only'));

  const novel = await pipeline({ enable_dialogue_aide: true, writing_mode: 'novel' });
  await runTurn(novel.h);
  assert.ok(novel.prompts.map(systemOf).join('\n').includes('apply to every character'));

  const textify = await pipeline({ enable_dialogue_aide: true, writing_mode: 'rp', rp_impersonation_scope: 'all' });
  await runTurn(textify.h);
  assert.equal(textify.prompts.filter(body => systemOf(body).includes('DIALOGUE & SPEECHCRAFT')).length, 0);
});
