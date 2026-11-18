'use strict';
// 창작 지침 비우기: 옛 User Intent 기록이 남아 있어도 비운 SHADOW 지침이 다시 들어오지 않고,
// 저장에 실패하면 성공으로 표시하지 않는다.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./host.cjs');
const prefix = 'serial_gradation_agents_for_rp:';
const legacy = JSON.stringify({ version: 1, designs: { old: { updatedAt: 1, manualUserIntent: { enabled: true, purpose: 'Recovered', instructions: ['LEGACY_USER_DIRECTION'], updatedAt: 1 } } } });

test('a cleared SHADOW instruction is not re-imported from the legacy record', async () => {
  const h = await load({ storage: { [prefix + 'writer_designs:v1']: legacy } });
  await h.plugin.clearCreativeDirection('aide_character');
  let saved = await h.plugin.getPromptOverrides();
  assert.ok(saved.before.shadow_act.customPrompt.includes('LEGACY_USER_DIRECTION'), '처음 한 번은 가져온다');
  await h.plugin.clearCreativeDirection('shadow_act');
  await h.plugin.clearCreativeDirection('aide_world');
  saved = await h.plugin.getPromptOverrides();
  assert.equal(saved.before.shadow_act.customPrompt, '', '비운 지침이 되살아나지 않는다');
  assert.equal(h.store.get(prefix + 'writer_designs:v1'), legacy, '옛 기록은 건드리지 않는다');
});

test('a failed clear is reported as a failure', async () => {
  const h = await load();
  await h.plugin.savePromptOverrides({ before: { aide_plot: { mode: 'replace', customPrompt: 'KEEP_ME' } } });
  const original = h.store.set.bind(h.store);
  h.store.set = (key, value) => {
    if (key === prefix + 'prompt_overrides:v2') throw new Error('DISK_FULL');
    return original(key, value);
  };
  await assert.rejects(() => h.plugin.clearCreativeDirection('aide_plot'));
  h.store.set = original;
  const saved = await h.plugin.getPromptOverrides();
  assert.equal(saved.before.aide_plot.customPrompt, 'KEEP_ME');
});
