'use strict';
// Regressions from live GRADIA runs with deepseek-v4.1-flash through Ollama (2026-11-15).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./gradia/host.cjs');

const seam = '  const publicApi = Object.freeze({';
const liveHost = (api = {}) => load({ api, transformSource: source => {
  assert.ok(source.includes(seam));
  return source.replace(seam, '  globalThis.__testInternals = { sceneTimeOfDay, buildDraftPatchDocument, applyDraftPatchOperations, callOllamaNative, aidePatchOutputTokenBudget, stageOutputTokenBudget, loadSettings, resolvePreset, callLLMWithPreset };\n' + seam);
} });
const internals = async api => (await liveHost(api)).internals;
const plain = value => JSON.parse(JSON.stringify(value));

test('상태 time of day ignores times named for another day or as a span edge', async () => {
  const { sceneTimeOfDay } = await internals();
  const label = value => (sceneTimeOfDay(value) || [])[1] || null;
  // The live night scene that produced "morning stiffness": the only 아침 was tomorrow's.
  assert.equal(label('내일 아침 비가 그치면 바로 떠날 거야.'), null);
  assert.equal(label('아침부터 돌던 물소리가 끊겼다. 밤이 깊었다.'), 'night');
  assert.equal(label('밤이 깊었고, 아침이 오려면 멀었다.'), 'night');
  assert.equal(label('저녁을 먹고 나니 밤이 깊었다.'), 'night', 'the time named last is the scene time');
  assert.equal(label('밤 열한 시, 주인은 여관 문을 잠갔다. 서윤은 오후에 왼쪽 손목을 베었다.'), 'night');
  assert.equal(label('어제 저녁에 다쳤다.'), null);
  assert.equal(label('창밖이 밝아 오는 아침이었다.'), 'morning');
});

test('a patch hash copied from a neighbouring block resolves by content instead of rolling back the turn', async () => {
  const { buildDraftPatchDocument, applyDraftPatchOperations } = await internals();
  const draft = ['서윤이 칼을 닦았다.', '"왼팔, 아까부터 한 번도 안 내렸어. 국그릇 들 때도."', '하진이 붕대를 내려놓았다.', '서윤이 숨을 삼켰다.'].join('\n\n');
  const doc = buildDraftPatchDocument(draft);
  const [first, second, , fourth] = doc.blocks;
  // Live slip: the Character AIDE cited the previous block's hash for the block it rewrote.
  const edits = [
    { operation: 'replace', target: second.id, expectedHash: first.hash, content: '"왼팔, 아까부터 한 번도 안 움직였어. 국그릇 들 때도."' },
    { operation: 'replace', target: fourth.id, expectedHash: fourth.hash, content: '서윤이 짧게 숨을 삼켰다.' }
  ];
  const out = plain(applyDraftPatchOperations(doc, edits));
  assert.equal(out.ok, true, JSON.stringify(out.skipped));
  assert.deepEqual(out.applied.map(edit => [edit.target, edit.hashSlipResolved || 'exact']), [[second.id, 'id_content_match'], [fourth.id, 'exact']]);
  assert.match(out.draft, /한 번도 안 움직였어/);
  assert.match(out.draft, /서윤이 칼을 닦았다\./, 'the block whose hash was cited stays');

  // Ambiguous content keeps the strict skip, and a delete never guesses.
  const ambiguous = plain(applyDraftPatchOperations(doc, [{ operation: 'replace', target: second.id, expectedHash: first.hash, content: '전혀 다른 문장이다.' }]));
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.skipped[0].skipReason, 'target_hash_mismatch');
  const removal = plain(applyDraftPatchOperations(doc, [{ operation: 'delete', target: second.id, expectedHash: first.hash }]));
  assert.equal(removal.skipped[0].skipReason, 'target_hash_mismatch');

  const repeated = buildDraftPatchDocument(draft + '\n\n' + first.text);
  const duplicateHash = plain(applyDraftPatchOperations(repeated, edits));
  assert.equal(duplicateHash.ok, false);
  assert.equal(duplicateHash.skipped[0].skipReason, 'target_hash_mismatch');
  assert.equal(duplicateHash.draft, draft + '\n\n' + first.text);
});

test('native Ollama always states thinking, whatever family the model name maps to', async () => {
  const bodies = [];
  const nativeFetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, status: 200, text: async () => JSON.stringify({ message: { content: 'ok' }, done: true, done_reason: 'stop' }),
      json: async () => ({ message: { content: 'ok' }, done: true, done_reason: 'stop' }) };
  };
  const { callOllamaNative } = await internals({ nativeFetch, fetch: nativeFetch });
  const base = { provider: 'ollama', url: 'http://127.0.0.1:11434', model: 'deepseek-v4.1-flash:1017-cloud', max_tokens: 4096, timeout_ms: 1000 };
  // A DeepSeek model name maps to the 'deepseek' family; "off" used to send no think field at all.
  await callOllamaNative({ ...base, reasoning_preset: 'off' }, 'sys', 'user', {});
  await callOllamaNative({ ...base, reasoning_preset: 'auto', reasoning_effort: 'low' }, 'sys', 'user', {});
  await callOllamaNative({ ...base, reasoning_preset: 'auto', reasoning_effort: 'max' }, 'sys', 'user', {});
  await callOllamaNative({ ...base, reasoning_preset: 'auto' }, 'sys', 'user', {});
  assert.deepEqual(bodies.map(body => body.think), [false, 'low', 'high', false]);
});

test('an AIDE patch with thinking gets room to think before its patch text', async () => {
  const { aidePatchOutputTokenBudget } = await internals();
  const draft = '서윤이 칼을 닦았다. '.repeat(300);
  const thinking = { provider: 'ollama', model: 'deepseek-v4.1-flash:1017-cloud', reasoning_preset: 'ollama', reasoning_effort: 'low', max_tokens: 16384 };
  const off = { ...thinking, reasoning_preset: 'off', reasoning_effort: 'none' };
  const withThinking = aidePatchOutputTokenBudget({ quickProfile: 'balanced' }, draft, 16384, thinking);
  const without = aidePatchOutputTokenBudget({ quickProfile: 'balanced' }, draft, 16384, off);
  // Live AIDE calls used up to ~8.9k tokens with thinking; ~6k first attempts ran out.
  assert.ok(withThinking >= 12000, 'thinking budget: ' + withThinking);
  assert.ok(withThinking <= 16384, 'never above the preset max_tokens');
  assert.ok(without < 8192, 'no thinking keeps the patch-sized budget: ' + without);
});

test('reasoning analysis reserves retry room from the preset ceiling once', async () => {
  const { stageOutputTokenBudget } = await internals();
  const preset = { provider: 'ollama', model: 'deepseek-v4.1-flash:1017-cloud', reasoning_preset: 'ollama', reasoning_effort: 'low', max_tokens: 16384 };
  assert.equal(stageOutputTokenBudget({}, 'aide_world', 'analysis phase', preset), 11468);
  const wideCtxBudget = stageOutputTokenBudget({}, 'aide_world', 'analysis phase', { ...preset, extra_body_json: JSON.stringify({ options: { num_ctx: 65536 } }) });
  assert.equal(wideCtxBudget, 13108);
  assert.ok(preset.max_tokens > wideCtxBudget);
});

test('saved draft budget presets supply the mode-specific cap and low effort to native Ollama', async () => {
  const bodies = [];
  const nativeFetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, status: 200, text: async () => JSON.stringify({ message: { content: 'ok' }, done: true, done_reason: 'stop' }) };
  };
  const { plugin, internals: { loadSettings, resolvePreset, callLLMWithPreset } } = await liveHost({ nativeFetch, fetch: nativeFetch });
  await plugin.saveProviderPreset('writer', {
    provider: 'ollama', url: 'http://127.0.0.1:11434', model: 'deepseek-v4.1-flash:1017-cloud',
    context_window: 256000, max_tokens: 4096, reasoning_preset: 'off', thinking_type: 'disabled',
    extra_body: { think: false, options: { num_predict: 600, top_k: 20 } }
  });
  for (const [id, lightweight, heavyweight, min, max] of [
    ['minimum', 12288, 16384, 3000, 5000],
    ['balanced', 16384, 20480, 5000, 7000],
    ['maximum', 24576, 32768, 8000, 12000]
  ]) {
    for (const [mode, cap] of [['lightweight', lightweight], ['heavyweight', heavyweight]]) {
      await plugin.saveRuntimeSettings({ default_preset: 'writer', multi_pipeline_mode: mode, quick_profile: 'quality', draft_budget_preset: id });
      const settings = await loadSettings();
      assert.equal(settings.targetDraftMinChars, min);
      assert.equal(settings.targetDraftMaxChars, max);
      for (const [stage, phase] of [['shadow_act', 'draft'], ['aide_world', 'analysis'], ['aide_body_state', 'patch']]) {
        assert.equal(resolvePreset(settings, stage).preset.max_tokens, cap);
        const result = await callLLMWithPreset(settings, stage, 'system', 'user', { promptPhase: phase, maxTokens: 40000 });
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal(bodies.at(-1).think, 'low');
        assert.equal(bodies.at(-1).options.num_predict, cap);
        assert.equal(bodies.at(-1).options.top_k, 20);
      }
      assert.equal(resolvePreset(settings, 'input_assist').preset.max_tokens, 4096);
      assert.equal(settings.presets.writer.max_tokens, 4096);
    }
  }
  await plugin.saveProviderPreset('other', { provider: 'ollama', model: 'qwen3:8b', max_tokens: 6000 });
  assert.equal(resolvePreset({ ...await loadSettings(), defaultPresetName: 'other' }, 'shadow_act').preset.max_tokens, 6000);
});
