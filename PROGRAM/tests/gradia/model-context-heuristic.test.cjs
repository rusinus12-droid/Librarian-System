'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {load} = require('./host.cjs');

const capacity = (plugin, preset) => plugin.debugResolveReferenceCapacity({
  quickProfile: 'balanced', defaultPreset: 'default', presets: {default: {max_tokens: 4096, ...preset}}
}, {stageNames: ['shadow_act']});

test('DeepSeek V4.1 Flash cloud admits the reported 20039-character skill without inventing a 64k limit', async () => {
  const {plugin}=await load();
  for(const model of ['deepseek-v4.1-flash:1017-cloud','deepseek-v4.1-flash:cloud','deepseek-ai/deepseek-v4.1-flash']){
    const preset={provider:'ollama_cloud',model,context_window:0,max_tokens:16384};
    assert.equal(capacity(plugin,preset).stages[0].contextTokens,1000000);
    const options={preset,selections:{shadow_act:['reported']},customSkills:{reported:{id:'reported',raw:'---\nname: reported\ndescription: Reported size\n---\nX'}}};
    const initial=plugin.debugSkillSelectionForStage('shadow_act',options).budget;
    options.customSkills.reported.raw+='x'.repeat(20039-initial.chars);
    const admitted=plugin.debugSkillPromptBudget('shadow_act',options);
    assert.equal(admitted.chars,20039);assert.equal(admitted.maxSkillChars,24000);
    options.preset={...preset,context_window:64000};
    assert.throws(()=>plugin.debugSkillPromptBudget('shadow_act',options),/한도/);
    options.preset={...preset,catalog_context_window:64000,metadata_model_id:model};
    assert.throws(()=>plugin.debugSkillPromptBudget('shadow_act',options),/한도/);
  }
  // DeepSeek documents 128K for deepseek-chat/reasoner (V3.x); only unknown DeepSeek names keep 64K.
  assert.equal(capacity(plugin,{provider:'deepseek',model:'deepseek-chat'}).stages[0].contextTokens,128000);
  assert.equal(capacity(plugin,{provider:'deepseek',model:'deepseek-coder-legacy'}).stages[0].contextTokens,64000);
});

test('the V4.1 Flash context handling applies to other model families, and a name guess never blocks a skill', async () => {
  const {plugin}=await load();
  const expected={
    'deepseek-v4-pro:cloud':1000000,'deepseek-v4-flash':1000000,'deepseek/deepseek-v3.2':128000,
    'kimi-k2-thinking:cloud':256000,'glm-4.6:cloud':128000,'qwen3-coder:480b-cloud':131072,
    'gpt-oss:120b-cloud':131072,'gpt-5.6':400000,'claude-opus-5':200000,'minimax-m2:cloud':1000000
  };
  for(const [model,tokens] of Object.entries(expected)){
    const result=capacity(plugin,{provider:'ollama_cloud',model,max_tokens:16384});
    assert.equal(result.stages[0].contextTokens,tokens,model);
    assert.equal(result.stages[0].contextSource,'model_heuristic',model);
  }
  // A 64K guess (unknown DeepSeek name) with a large output budget would leave less than
  // the selected Skill; that guess warns instead of failing the run.
  const preset={provider:'deepseek',model:'deepseek-coder-legacy',max_tokens:60000};
  const options={preset,selections:{shadow_act:['reported']},customSkills:{reported:{id:'reported',raw:'---\nname: reported\ndescription: Reported size\n---\n'+'x'.repeat(20000)}}};
  const budget=plugin.debugSkillPromptBudget('shadow_act',options);
  assert.equal(budget.fits,true);assert.equal(budget.heuristicOverride,true);
  options.preset={...preset,context_window:64000};
  assert.throws(()=>plugin.debugSkillPromptBudget('shadow_act',options),/한도/);
});

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
