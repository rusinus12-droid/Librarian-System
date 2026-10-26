'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {load} = require('./host.cjs');

const capacity = (plugin, preset) => plugin.debugResolveReferenceCapacity({
  quickProfile: 'balanced', defaultPreset: 'default', presets: {default: {max_tokens: 4096, ...preset}}
}, {stageNames: ['shadow_act']});

test('GPT-4.1 family keeps the reference profile and admits a normal skill without manual metadata', async () => {
  const {plugin} = await load();
  for (const model of ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-4.1-2025-04-14', 'openai/gpt-4.1']) {
    const preset = {provider: 'openai', model, context_window: 0, catalog_context_window: 0};
    const result = capacity(plugin, preset);
    assert.equal(result.effectiveBudgetChars, result.profileCapChars, model + ' must not inherit the 8K GPT-4 limit');
    assert.ok(result.stages[0].contextTokens >= 1000000, model);
    const skill = plugin.debugSkillPromptBudget('shadow_act', {
      preset, selections: {shadow_act: ['physical-conflict']}, system: 'Preserve current input', shared: 'Complete references'
    });
    assert.equal(skill.fits, true, model);
    assert.equal(skill.maxSkillChars, 24000, model);
  }
});

test('legacy GPT-4 and explicitly smaller contexts keep their safety limits', async () => {
  const {plugin} = await load();
  for (const model of ['gpt-4', 'gpt-4-0314', 'gpt-4-0613']) {
    assert.equal(capacity(plugin, {provider: 'openai', model}).stages[0].contextTokens, 8192, model);
  }
  const preset = {provider: 'openai', model: 'gpt-4.1', context_window: 16000};
  assert.equal(capacity(plugin, preset).stages[0].contextTokens, 16000);
  assert.throws(() => plugin.debugSkillPromptBudget('shadow_act', {
    preset, selections: {shadow_act: ['physical-conflict']}
  }), /한도/);
  const catalog = {...preset, context_window: 0, catalog_context_window: 32000, metadata_model_id: 'gpt-4.1'};
  assert.equal(capacity(plugin, catalog).stages[0].contextTokens, 32000);
  assert.ok(capacity(plugin, {...catalog, metadata_model_id: 'old-model'}).stages[0].contextTokens >= 1000000);
});

test('unknown GPT-4 variants retain an unverified fallback and Gemini 2.5 Pro is not treated as 2M', async () => {
  const {plugin} = await load();
  const unknown = capacity(plugin, {provider: 'custom', model: 'gpt-4.custom-unknown'});
  assert.equal(unknown.stages[0].contextTokens, 0);
  assert.equal(unknown.effectiveBudgetChars, unknown.profileCapChars);
  assert.equal(unknown.warnings.length, 1);
  assert.equal(capacity(plugin, {provider: 'google', model: 'gemini-2.5-pro'}).stages[0].contextTokens, 1000000);
});
