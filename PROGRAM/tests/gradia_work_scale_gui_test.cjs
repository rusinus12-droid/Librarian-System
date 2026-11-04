'use strict';
// The home page's work scale: one choice sets the budgets, and model presets move only when asked.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { gradia, wait, sleep } = require('./fixtures/companion_gui_fixture.cjs');
const AGENTS = 'serial_gradation_agents_for_rp:agent_slots:v2';
const RUNTIME = 'serial_gradation_agents_for_rp:runtime_settings:v2';
const PROVIDERS = 'serial_gradation_agents_for_rp:provider_presets:v2';
const preset = (f, name, values) => f.plugin.saveProviderPreset(name, { provider: 'openai', url: 'https://api.openai.com/v1/chat/completions', key: 'synthetic-only', model: 'gpt-5.6', request_format: 'chat_completions', context_window: 128000, reasoning_preset: 'off', stream: false, ...values });
const choose = async (f, label) => { [...f.doc.querySelectorAll('#q-quality .choice')].find(n => n.textContent.includes(label)).click(); await sleep(60); };
const action = async (f, name) => { f.doc.querySelector('[data-work-scale-action="' + name + '"]').click(); await sleep(60); };
const save = async f => { f.doc.querySelector('#savebar [data-save]').click(); await wait(() => !f.plugin.debugGuiStateInfo().dirty, 'save'); };
async function open(f) { await f.plugin.openSettingsGui(); await f.plugin.debugNavigateGui('quick', 'flow'); await sleep(30); }

for (const [label, profile, turns, reference, memory] of [['적게', 'fast', 4, 24000, 12000], ['균형', 'balanced', 8, 48000, 24000], ['많이', 'quality', 12, 96000, 48000]]) test(label + ' sets turns, references and memory together', async () => {
  const f = await gradia();
  try {
    await open(f); if (profile === 'balanced') await choose(f, '적게');
    await choose(f, label); await save(f);
    const slot = JSON.parse(f.store.get(AGENTS)).slots.shadow_act, runtime = JSON.parse(f.store.get(RUNTIME)).settings;
    assert.equal(slot.turn_window, turns); assert.equal(slot.max_chars, reference);
    assert.equal(runtime.quick_profile, profile); assert.equal(Number(runtime.memory_budget_chars), memory);
  } finally { await f.close(); }
});
test('the panel shows each model and what it needs, and choosing a scale never touches a model preset', async () => {
  const f = await gradia();
  try {
    await preset(f, 'small', { max_tokens: 4096 });
    await f.plugin.saveRuntimeSettings({ ...await f.plugin.getRuntimeSettings(), default_preset: 'small', enable_shadow_act: true, target_draft_min_chars: 3000, target_draft_max_chars: 5000 });
    await open(f);
    const row = f.doc.querySelector('[data-work-scale-stage="shadow_act"]');
    assert.match(row.textContent, /⚠/); assert.match(row.textContent, /gpt-5\.6/); assert.match(row.textContent, /맥스 4,096 \/ 필요 6,082/);
    await choose(f, '많이'); await save(f);
    assert.equal(JSON.parse(f.store.get(PROVIDERS)).small?.max_tokens ?? JSON.parse(f.store.get(PROVIDERS)).presets?.small?.max_tokens, 4096);
  } finally { await f.close(); }
});
test('권장안 lists the model change, and only the second click applies it', async () => {
  const f = await gradia();
  try {
    await preset(f, 'small', { max_tokens: 4096 });
    await f.plugin.saveRuntimeSettings({ ...await f.plugin.getRuntimeSettings(), default_preset: 'small', enable_shadow_act: true, target_draft_min_chars: 3000, target_draft_max_chars: 5000 });
    await open(f);
    await action(f, 'recommend');
    assert.match(f.doc.querySelector('[data-work-scale-confirm]').textContent, /small: 맥스 토큰 4,096 → 6,144|small: 맥스 토큰 4,096 → 6,082/);
    assert.match(f.doc.querySelector('[data-work-scale-stage="shadow_act"]').textContent, /맥스 4,096/, 'nothing moved yet');
    await action(f, 'cancel'); assert.equal(f.doc.querySelector('[data-work-scale-confirm]'), null);
    await action(f, 'recommend'); await action(f, 'confirm');
    assert.equal(f.plugin.debugInspectWorkScale().stages.every(stage => stage.ok), true);
    assert.match(f.doc.querySelector('[data-work-scale-result]').textContent, /설정이 서로 맞습니다|기억 읽기/);
  } finally { await f.close(); }
});
test('커스텀 opens number fields and marks the scale as directly adjusted', async () => {
  const f = await gradia();
  try {
    await preset(f, 'small', { max_tokens: 4096 });
    await f.plugin.saveRuntimeSettings({ ...await f.plugin.getRuntimeSettings(), default_preset: 'small' });
    await open(f); await choose(f, '균형');
    await action(f, 'custom');
    const set = async (key, value) => { const input = f.doc.querySelector('[data-work-scale-field="' + key + '"]'); input.value = String(value); input.dispatchEvent(new f.doc.defaultView.Event('change', { bubbles: true })); await sleep(60); };
    await set('memory', 30000); await set('reference', 50000); await set('turns', 6); await set('maxTokens', 20000);
    assert.equal(f.doc.querySelector('[data-work-scale-field="maxTokens"]').value, '20000', 'the fields stay open');
    assert.match(f.doc.querySelector('[data-work-scale]').textContent, /직접 조정 · 최근 6턴 · 참조 50,000자 · 기억 30,000자/);
    await save(f);
    const runtime = JSON.parse(f.store.get(RUNTIME)).settings;
    assert.equal(runtime.quick_profile, 'custom'); assert.equal(Number(runtime.memory_budget_chars), 30000);
    assert.equal(JSON.parse(f.store.get(AGENTS)).slots.shadow_act.max_chars, 50000);
  } finally { await f.close(); }
});
test('설정 점검 reports context overflow and a missing connection', async () => {
  const f = await gradia();
  try {
    await preset(f, 'tiny', { max_tokens: 16384, context_window: 20000 });
    await f.plugin.saveRuntimeSettings({ ...await f.plugin.getRuntimeSettings(), default_preset: 'tiny', enable_shadow_act: true });
    await open(f); await action(f, 'inspect');
    assert.match(f.doc.querySelector('[data-work-scale-result]').textContent, /모델 문맥/);
    await action(f, 'inspect'); assert.equal(f.doc.querySelector('[data-work-scale-result]'), null, 'pressing again closes it');
    await f.plugin.saveRuntimeSettings({ ...await f.plugin.getRuntimeSettings(), default_preset: 'missing-preset' });
    assert.ok(f.plugin.debugInspectWorkScale);
  } finally { await f.close(); }
});
test('saved budgets that no longer match a profile stay as they are and show as directly adjusted', async () => {
  const f = await gradia({ storage: { [AGENTS]: JSON.stringify({ version: 3, slots: Object.fromEntries(['shadow_act', 'aide_character', 'aide_world', 'aide_plot'].map(id => [id, { turnWindow: 8, maxChars: 96000 }])) }), [RUNTIME]: JSON.stringify({ version: 3, settings: { quick_profile: 'balanced' } }) } });
  try {
    await open(f);
    assert.match(f.doc.querySelector('[data-work-scale]').textContent, /직접 조정 · 최근 8턴 · 참조 96,000자/);
    assert.equal(JSON.parse(f.store.get(AGENTS)).slots.shadow_act.max_chars ?? JSON.parse(f.store.get(AGENTS)).slots.shadow_act.maxChars, 96000);
  } finally { await f.close(); }
});
