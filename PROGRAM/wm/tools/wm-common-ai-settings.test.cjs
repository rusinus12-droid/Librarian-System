'use strict';
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, profile, plain, required } = require('./wm-analysis-preset-test-support.cjs');
let r, api;
before(async () => { r = await fixture(); api = r.ai; });
const normalize = x => required(api, 'normalizeCommonAnalysisSettings')(x);
const resolve = x => required(api, 'resolveCommonAnalysisPreset')(x);
const routingKeys = ['llmRouting', 'llmRoutingJson', 'llm_routing_json'];

test('canonical_storage_discards_every_retired_route_alias_without_dropping_profiles', () => {
  const input = { useLLM: true, llmPresets: { saved: profile('saved-model') }, llmDefaultPreset: 'saved',
    llmRouting: { storyAuthor: 'aux' }, llmRoutingJson: '{"liveExtraction":"aux"}', llm_routing_json: '{"director":"aux"}' };
  const stored = api.canonicalSettingsForStorage(input);
  for (const key of routingKeys) assert.equal(Object.hasOwn(stored, key), false, `retired ${key}`);
  assert.equal(stored.llmPresets.saved.model, 'saved-model');
  assert.equal(input.llmRouting.storyAuthor, 'aux', 'input remains untouched');
});
test('preserves_primary_aux_and_named_definitions_and_zero_options', () => {
  const input = { useLLM: true, llm: profile('primary-model'), auxLlm: profile('aux-model', {enabled:false}),
    llmPresets: { named: { extends: 'aux', model:'named-model', temp:0, retry:0, extension:{marker:'public-extension'} } }, llmDefaultPreset:'named' };
  const {config} = normalize(input);
  assert.equal(config.llm.model, 'primary-model'); assert.equal(config.auxLlm.model, 'aux-model');
  assert.equal(config.llmPresets.primary.model, 'primary-model'); assert.equal(config.llmPresets.aux.enabled,false);
  assert.equal(config.llmPresets.named.model,'named-model'); assert.equal(config.llmPresets.named.temp,0);
  assert.equal(config.llmPresets.named.retry,0); assert.equal(config.llmPresets.named.extension.marker,'public-extension');
});
test('canonical_selection_beats_alias_even_when_explicitly_empty', () => {
  const x = {useLLM:true,llm:profile('p'),llmPresets:{other:profile('o')},llmDefaultPreset:'',defaultPreset:'other'};
  assert.equal(normalize(x).config.llmDefaultPreset,''); assert.equal(resolve(x).ok,false);
  assert.equal(normalize({...x,llmDefaultPreset:'primary'}).config.llmDefaultPreset,'primary');
});
test('only_genuinely_absent_selection_defaults_to_primary', () => {
  assert.equal(resolve({useLLM:true,llm:profile('p')}).presetName,'primary');
  for (const llmDefaultPreset of ['',null,'missing']) {
    const x=resolve({useLLM:true,llm:profile('p'),llmDefaultPreset}); assert.equal(x.ok,false);
    assert(x.profile===null,'must not expose fallback identity');
  }
});
test('missing_selected_name_is_unavailable_and_not_primary_or_aux', () => {
  const x=resolve({useLLM:true,llm:profile('p'),auxLlm:profile('a',{enabled:true}),llmDefaultPreset:'unknown'});
  assert.equal(x.ok,false); assert.equal(x.reason,'selected_preset_missing'); assert(x.profile===null,'no fallback profile');
});
test('disabled_selection_is_not_auto_enabled', () => {
  const x={useLLM:true,llm:profile('p'),llmPresets:{paused:profile('named',{enabled:false})},llmDefaultPreset:'paused'};
  assert.equal(normalize(x).config.llmPresets.paused.enabled,false);
  assert.equal(resolve(x).reason,'selected_preset_disabled'); assert(resolve(x).profile===null,'no disabled fallback profile');
});
test('explicit_blank_identity_is_unconfigured_not_inherited_fallback', () => {
  for (const blank of [{model:''},{key:''},{provider:'custom',url:''}]) {
    const x=resolve({useLLM:true,llm:profile('p'),llmPresets:{empty:{...profile('named'),...blank}},llmDefaultPreset:'empty'});
    assert.equal(x.ok,false); assert.equal(x.reason,'selected_preset_unconfigured');
  }
});
test('paused_analysis_stays_paused_when_selection_is_valid', () => {
  const x={useLLM:false,llm:profile('p'),llmPresets:{named:profile('n')},llmDefaultPreset:'named'};
  assert.equal(normalize(x).config.useLLM,false); assert.equal(resolve(x).ok,false); assert.equal(resolve(x).reason,'analysis_disabled');
});
test('name_collisions_keep_definitions_with_deterministic_suffixes_and_no_ambiguous_selection', () => {
  const x={useLLM:true,llm:profile('p'),llmPresets:{'Same Name':profile('first'),'same_name':profile('second'),'same_name_2':profile('third')},llmDefaultPreset:'Same Name'};
  const a=normalize(x), b=normalize(x);
  assert(JSON.stringify(a)===JSON.stringify(b),'deterministic normalized contents'); assert.equal(new Set(Object.values(a.config.llmPresets).map(p=>p.model)).size,4);
  assert.equal(a.config.llmPresets.same_name.model,'first');
  assert(a.notices.includes('preset_name_collision')); assert.equal(resolve(a.config).ok,false);
  assert(JSON.stringify(normalize(a.config).config)===JSON.stringify(a.config),'normalization is idempotent');
});
test('primary_and_main_alias_collision_preserves_both_definitions', () => {
  const {config,notices}=normalize({useLLM:true,llm:profile('fallback'),llmPresets:{primary:profile('one'),main:profile('two')},llmDefaultPreset:'primary'});
  assert.equal(Object.values(config.llmPresets).filter(p=>['one','two'].includes(p.model)).length,2);
  assert(notices.includes('preset_name_collision')); assert.equal(resolve(config).ok,false);
});
test('nested_preset_envelope_and_legacy_selection_alias_are_read_without_writes', () => {
  const x={useLLM:true,llm:profile('p'),llmPresetsJson:JSON.stringify({presets:{legacy:profile('legacy')}}),defaultPreset:'legacy', llmRouting:{liveExtraction:'primary'}};
  const before=plain([...r.store]); const n=normalize(x);
  assert.equal(n.config.llmDefaultPreset,'legacy'); assert.equal(resolve(n.config).profile.model,'legacy');
  assert(n.notices.includes('legacy_routing_retired')); assert(JSON.stringify([...r.store])===JSON.stringify(before),'normalization does not write');
  assert.equal(n.config.llmPresets.legacy.model,'legacy');
});
test('unsafe_property_names_cannot_pollute_or_become_selectable_presets', () => {
  const x=JSON.parse('{"useLLM":true,"llmPresets":{"__proto__":{"polluted":true},"constructor":{"model":"bad"},"prototype":{"model":"bad"},"valid":{"provider":"ollama","model":"ok","url":"http://synthetic.invalid"}},"llmDefaultPreset":"valid"}');
  const n=normalize(x);
  for(const name of ['__proto__','constructor','prototype','proto'])assert.equal(Object.hasOwn(n.config.llmPresets,name),false);
  assert.equal({}.polluted,undefined);assert.equal(n.config.llmPresets.valid.model,'ok');
});
test('resolved_profile_is_a_deep_caller_owned_copy', () => {
  const x={useLLM:true,llm:profile('p'),llmPresets:{named:profile('n',{extra:{nested:['original']}})},llmDefaultPreset:'named'};
  const a=resolve(x),b=resolve(x); assert.equal(a.ok,true);a.profile.extra.nested[0]='changed';
  assert.equal(x.llmPresets.named.extra.nested[0],'original');assert.equal(b.profile.extra.nested[0],'original');
});
test('normalization_notices_are_closed_codes_without_names_credentials_or_urls', () => {
  const x=normalize({useLLM:true,llm:profile('p'),llmDefaultPreset:'missing-user-provided-name',llmRouting:{foo:'aux'}});
  const allowed=['legacy_routing_retired','selected_preset_missing','preset_name_collision','selected_preset_disabled'];
  assert(x.notices.every(n=>allowed.includes(n)));assert(!JSON.stringify(x.notices).includes('missing-user-provided-name'));
});
test('startup_args_override_saved_common_selection_but_never_task_routing', async () => {
  // Use actual registered native startup; Min legitimately inlines its private initializer.
  const {loadGui}=require('./libra_management_gui_integration_test.cjs');
  const q=await loadGui({nativeInitialization:true,store:new Map([['LMAI_Config',JSON.stringify({useLLM:true,llm:profile('p'),llmPresets:{saved:profile('s'),external:profile('e')},llmDefaultPreset:'saved',llmRouting:{director:'aux'}})]]),args:{llm_default_preset:'external',llm_routing_json:'{"director":"aux"}'}});
  try {assert.equal(q.api.MemoryEngine.CONFIG.llmDefaultPreset,'external');
  for(const key of routingKeys)assert.equal(Object.hasOwn(q.api.MemoryEngine.CONFIG,key),false);
  assert.equal(q.api.MemoryEngine.CONFIG.llmPresets.saved.model,'s');}finally{q.close();}
});

test('invalid_preset_json_cannot_bypass_canonical_writer_or_touch_storage',async()=>{
  const before=JSON.stringify([...r.store]);
  await assert.rejects(()=>api.writeCommonPluginSettings({useLLM:true,llmPresetsJson:'{invalid',llmRouting:{director:'aux'}}),/analysis_presets_invalid_json/);
  assert.equal(JSON.stringify([...r.store]),before,'rejected normalization must not issue storage write');
});
