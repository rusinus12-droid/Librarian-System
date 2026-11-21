'use strict';
// 지식 경계 AIDE (aide_knowledge_boundary): 문서 §7 의 판정 기준을 코드 계약으로 고정한다.
//  - 계단 장면에 없던 인물이 그 장면의 사실을 말하면 모델이 누설을 보고하고, 기록은 초안·근거 인용
//    대조를 통과한 것만 남는다(지어낸 판정은 버린다). 수정이 초안에 반영됐는지도 함께 남는다.
//  - 화면 안에서 들은 사실·공개 사실·보이는 단서로 한 추측은 "경계 안" 으로 남고 고치지 않는다.
//  - 유저 입력이 "X는 알고 있었다"고 정한 사실은 패킷에 input fixes 로 실려 누설로 보지 않는다.
//  - RP 모드에서 페르소나의 지식·대사는 고치지 않는다. 문장화 모드에서는 AIDE 자체가 쉽니다.
//  - AIDE 가 꺼져 있으면 프롬프트·출력·판독 어디에도 흔적이 없다.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./host.cjs');

const BLOCK = '[KNOWLEDGE BOUNDARY (지식 경계)';
const CHAT = { id: 'chat-kb', chatId: 'chat-kb', name: 'kb', message: [
  { role: 'user', chatId: 'u1', data: '준호가 문 앞에서 기다린다.' },
  { role: 'assistant', chatId: 'a1', data: '준호는 아무 말 없이 문 앞에 서서 기다렸다. 방문은 닫혀 있었다.' }
] };
const CHARACTER = { chaId: 'c-kb', name: '민아', chats: [CHAT], chatPage: 0, lorebook: [] };
const DRAFT = '민아는 방문을 열었다. “아직 여기 있었어?” 그녀는 준호가 밤새 문 앞에서 기다린 걸 이미 알고 있었다.';
const LEAK_QUOTE = '준호가 밤새 문 앞에서 기다린 걸 이미 알고 있었다';
const EVIDENCE_QUOTE = '문 앞에 서서 기다렸다';
const KEPT_QUOTE = '아직 여기 있었어?';
const systemOf = body => (body.messages || []).filter(m => m.role === 'system').map(m => m.content).join('\n');
const stageOf = body => (systemOf(body).match(/"stage":\s*"([^"]+)"/) || [])[1] || '';

// 지식 경계의 settle 은 host 인물 AIDE 호출 안에서 끝난다(별도 호출 없음).
const LEAK_REPORT = {
  knowledge_leaks: [
    { character: '민아', draft_quote: LEAK_QUOTE, fact: '준호가 밤새 문 앞에서 기다린 일',
      why_unknown: '민아는 방 안에 있었고 그 장면을 보지 못했다', evidence_quote: EVIDENCE_QUOTE,
      repair: 'guess', replacement: '설마 여기 있었어?' },
    { character: '민아', draft_quote: '초안에 없는 문장', fact: '없는 사실', why_unknown: '',
      evidence_quote: EVIDENCE_QUOTE, repair: 'remove', replacement: '' },
    { character: '민아', draft_quote: LEAK_QUOTE, fact: '없는 근거를 든 판정', why_unknown: '',
      evidence_quote: '근거에 없는 문장', repair: 'remove', replacement: '' }
  ],
  knowledge_kept: [{ character: '민아', draft_quote: KEPT_QUOTE, path: 'witnessed' }]
};

// The host answers like the real pipeline: analysis JSON for analysis calls, a patch envelope for
// patch calls (the character AIDE hosts the knowledge settle), the draft for the SHADOW call.
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
          edits: [], ...(stage === 'aide_character' ? LEAK_REPORT : {}) });
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
  const enabled = runtime.enable_knowledge_boundary_aide !== false;
  await h.plugin.saveAgentSlots({ ...slots, aide_knowledge_boundary: { ...(slots.aide_knowledge_boundary || {}), enabled } });
  return { h, prompts };
};
const runTurn = async (h, input = '민아는 그 사실을 알고 있었다. 방문을 열고 말을 건넨다.') =>
  h.hooks.beforeRequest([{ role: 'user', messageId: 'u-current', chatId: 'u-current', content: input }], 'model');
const readingsOf = h => Object.values(h.plugin.getRuntime().knowledgeBoundaryReadings || {});

test('§7 누설 보고는 초안·근거 인용을 대조하고, 통과한 것만 판독에 남기며, 초안 밖·근거 밖 판정은 버린다', async () => {
  const { h, prompts } = await pipeline({ enable_knowledge_boundary_aide: true });
  await runTurn(h);
  const blocks = prompts.filter(body => systemOf(body).includes(BLOCK));
  assert.ok(blocks.length >= 2, `knowledge block reaches the AIDE calls (${blocks.length})`);
  const host = prompts.find(body => stageOf(body) === 'aide_character');
  const hostText = systemOf(host);
  assert.ok(hostText.includes('OUTPUT: add a top-level "knowledge_leaks" array'), 'the host AIDE asks for repaired leaks');
  assert.ok(hostText.includes('"knowledge_kept" array'), 'and for the lines it checked and kept');
  assert.ok(hostText.includes('KNOWLEDGE BOUNDARY PACKET'), 'the host carries the packet');
  const packet = hostText.slice(hostText.indexOf('KNOWLEDGE BOUNDARY PACKET'));
  assert.ok(packet.includes('How to trace a fact'), 'the packet tells the stage how to trace a path');
  assert.ok(packet.includes('What the current input fixes'), 'a fact the input fixes is carried as not-a-leak');
  assert.ok(packet.includes('알고 있었다'), 'the input sentence itself is quoted');

  const readings = readingsOf(h);
  assert.equal(readings.length, 1, 'one reading for the run');
  const reading = readings[0];
  assert.equal((reading.leaks || []).length, 1, 'only the cited leak survives');
  assert.equal(reading.leaks[0].draftQuote, LEAK_QUOTE);
  assert.equal(reading.leaks[0].repair, 'guess');
  assert.equal(reading.leaks[0].applied, false, 'the stage returned no edits, so the reading says it was not applied');
  assert.equal((reading.kept || []).length, 1, 'the kept line is recorded with its path');
  assert.equal(reading.kept[0].path, 'witnessed');
  assert.equal((reading.dropped || []).length, 2, 'a quote absent from the draft or from the sources is dropped');
  assert.deepEqual(Array.from(reading.dropped, row => row.reason).sort(),
    ['draft_quote_not_in_draft', 'evidence_quote_not_in_sources']);
});

test('§7 AIDE 가 꺼져 있으면 프롬프트·판독 어디에도 흔적이 없다', async () => {
  const { h, prompts } = await pipeline({ enable_knowledge_boundary_aide: false });
  await runTurn(h);
  assert.equal(prompts.filter(body => systemOf(body).includes('지식 경계')).length, 0, 'no knowledge block in any prompt');
  assert.equal(prompts.filter(body => systemOf(body).includes('knowledge_leaks')).length, 0, 'no knowledge schema in any prompt');
  assert.equal(readingsOf(h).length, 0, 'nothing is recorded');
});

test('§7 RP 페르소나 보호·장면 연출·소설 모드의 문구가 모드에 맞게 바뀐다', async () => {
  const rp = await pipeline({ enable_knowledge_boundary_aide: true, writing_mode: 'rp', rp_impersonation_scope: 'persona' });
  await runTurn(rp.h);
  const rpText = rp.prompts.map(systemOf).join('\n');
  assert.ok(rpText.includes('RP mode: apply to NPCs only'), 'RP: persona knowledge is the user’s');
  assert.ok(rpText.includes('never repair them'), 'RP: persona lines are never repaired');

  const staging = await pipeline({ enable_knowledge_boundary_aide: true, writing_mode: 'rp', rp_impersonation_scope: 'persona_cast' });
  await runTurn(staging.h);
  assert.ok(staging.prompts.map(systemOf).join('\n').includes('Scene-staging RP mode'), 'staging: only added lines are checked');

  const novel = await pipeline({ enable_knowledge_boundary_aide: true, writing_mode: 'novel' });
  await runTurn(novel.h);
  assert.ok(novel.prompts.map(systemOf).join('\n').includes('Novel mode: apply to every character'), 'novel: every character is checked');

  const skipped = await pipeline({ enable_knowledge_boundary_aide: true, writing_mode: 'rp', rp_impersonation_scope: 'all' });
  await runTurn(skipped.h);
  assert.equal(skipped.prompts.filter(body => systemOf(body).includes(BLOCK)).length, 0, 'sentence-mode skips the AIDE');
});

const expose = source => source.replace(
  'globalThis.__testInternals = { clearStructuredSettings, fullDraftStagePrompt, Runtime };',
  'globalThis.__testInternals = { clearStructuredSettings, fullDraftStagePrompt, Runtime, knowledgeBoundaryStageActive, knowledgeBoundaryJsonProperties, knowledgeBoundaryVerifiedReadings, recordKnowledgeBoundaryOutput, knowledgeBoundaryReadingNotes };');

test('§7 출력 스키마(확인/판독)와 수정 반영 여부·판독 문구가 계약대로다', async () => {
  const { h } = await pipeline({ enable_knowledge_boundary_aide: true }, { captureInternals: true, transformSource: expose });
  const kb = h.internals;
  await runTurn(h);
  const raw = await h.plugin.getRuntimeSettings();
  assert.equal(raw.enable_knowledge_boundary_aide, true, 'the saved settings document carries the switch');
  const settings = kb.Runtime.settings;
  assert.equal(settings.enableKnowledgeBoundaryAide, true, 'the normalized runtime settings the stages read carry the switch');
  assert.equal(kb.knowledgeBoundaryStageActive(settings), true);
  assert.deepEqual(Object.keys(kb.knowledgeBoundaryJsonProperties('shadow_act', settings)), ['knowledge_check'], 'a read-only stage only notes');
  assert.deepEqual(Object.keys(kb.knowledgeBoundaryJsonProperties('aide_character', settings)).sort(), ['knowledge_kept', 'knowledge_leaks'], 'the host settles with repairs');

  const draft = '민아는 준호가 밤새 기다린 걸 알고 있었다. 방문을 열었다.';
  const ledger = { knowledgeDraftBefore: draft, knowledgeDraftAfter: '민아는 방문을 열었다.',
    knowledgeEvidenceText: '준호는 문 앞에 서서 기다렸다.' };
  const repaired = kb.knowledgeBoundaryVerifiedReadings({ knowledgeLeaks: [{ character: '민아',
    draft_quote: '밤새 기다린 걸 알고 있었다', fact: '기다린 일', why_unknown: '보지 못했다',
    evidence_quote: '문 앞에 서서 기다렸다', repair: 'remove' }], knowledgeKept: [] }, ledger);
  assert.equal(repaired.leaks.length, 1);
  assert.equal(repaired.leaks[0].applied, true, 'the leaking words are gone from the patched draft');

  const unrepaired = kb.knowledgeBoundaryVerifiedReadings({ knowledgeLeaks: [{ character: '민아',
    draft_quote: '밤새 기다린 걸 알고 있었다', evidence_quote: '문 앞에 서서 기다렸다', repair: 'remove' }] },
    { ...ledger, knowledgeDraftAfter: draft });
  assert.equal(unrepaired.leaks[0].applied, false, 'a report the stage did not edit stays marked as not applied');

  const dropped = kb.knowledgeBoundaryVerifiedReadings({ knowledgeLeaks: [
    { character: '민아', draft_quote: '없는 문장', evidence_quote: '문 앞에 서서 기다렸다' },
    { character: '민아', draft_quote: '밤새 기다린 걸 알고 있었다', evidence_quote: '없는 근거' }
  ] }, ledger);
  assert.equal(dropped.leaks.length, 0);
  assert.deepEqual(Array.from(dropped.dropped, row => row.reason).sort(), ['draft_quote_not_in_draft', 'evidence_quote_not_in_sources']);

  const scopeKey = kb.Runtime.activeScopeKey;
  assert.ok(scopeKey, 'the host chat gives the reading a scope');
  kb.recordKnowledgeBoundaryOutput(ledger, 'aide_character', {
    knowledgeLeaks: [{ character: '민아', draft_quote: '밤새 기다린 걸 알고 있었다',
      why_unknown: '보지 못했다', evidence_quote: '문 앞에 서서 기다렸다', repair: 'ask' }],
    knowledgeKept: [{ character: '민아', draft_quote: '방문을 열었다', path: 'visible_cue' }]
  }, settings);
  const notes = Array.from(kb.knowledgeBoundaryReadingNotes(scopeKey), row => row.title);
  assert.ok(notes.some(title => title.includes('누설') && title.includes('질문으로 바꿈')), 'a repair is labelled in words');
  assert.ok(notes.some(title => title.includes('경계 안') && title.includes('보이는 단서')), 'a kept guess is labelled with its path');

  const off = { ...settings, enableKnowledgeBoundaryAide: false };
  const quiet = { knowledgeChecks: [], knowledgeDraftBefore: draft, knowledgeDraftAfter: '' };
  kb.recordKnowledgeBoundaryOutput(quiet, 'aide_character', { knowledgeLeaks: [{ character: '민아', draft_quote: '밤새 기다린 걸 알고 있었다', evidence_quote: '문 앞에 서서 기다렸다' }] }, off);
  assert.equal((quiet.knowledgeChecks || []).length, 0, 'off records nothing');
  assert.equal(kb.knowledgeBoundaryStageActive(off), false);
  assert.equal(Object.keys(kb.knowledgeBoundaryJsonProperties('aide_character', off)).length, 0, 'off adds no schema');
});
