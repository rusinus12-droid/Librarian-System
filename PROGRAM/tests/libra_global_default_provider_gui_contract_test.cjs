'use strict';
const { releaseVersion, releaseText, releasePattern } = require('./fixtures/release_versions.cjs');


const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'plugins', 'LIBRA.js'), 'utf8');
const between = (start, end) => {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing start marker: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing end marker: ${end}`);
  return source.slice(from, to);
};

assert.match(source, releasePattern("^\\/\\/@version {libra}\\s*$", "m"),
  releaseText('the reserved default-connection retirement must remain present in LIBRA {libra}'));
assert.match(source, /보조 모델 호출 테스트/,
  'the AI connection page exposes an explicit physical auxiliary-model call probe');
assert.match(source, /libra\.risuai_auxiliary_call_probe\.v1/,
  'the auxiliary-model call probe retains a structured session diagnostic');
assert.match(source, /testRisuAuxiliaryCall/,
  'the auxiliary-model call probe is available to runtime diagnostics');

const approved=require('./helpers/libra_approved_gui_contract.cjs');
const providerGui=approved.extract(source,'buildApprovedMockupSettingsPanel');
assert.match(providerGui,/전역 기본 AI 연결/,'actual canonical default fold remains reachable');
assert.match(providerGui,/configuredDefaultName=normalizeProviderPresetBindingName\(runtime\.defaultPresetName\)\|\|RISUAI_AUX_PRESET_NAME/,'retired default binding normalizes to concrete auxiliary authority');
assert.match(providerGui,/providers\[configuredDefaultName\][\s\S]*providers\[RISUAI_AUX_PRESET_NAME\][\s\S]*names\[0\]/,'missing saved names retain the established fallback');
assert.doesNotMatch(providerGui,/providers\.default|\? 'default'/,'reserved default row stays retired');
assert.match(providerGui,/selectNode\(effectiveDefaultName,names\.map\(name=>\[name,presetDisplayName\(name\)\]\),next=>\{runtime\.defaultPresetName=next;markGuiDirty\(\);queueGuiRender\(0\)/,'selection uses saved names and participates in draft/save');
assert.match(providerGui,/단계별 AI 연결에서 전역 기본 연결을 사용하도록 둔 모든 기능이 공유하는 폴백입니다/);
assert.doesNotMatch(providerGui,/LIBRA·GRADIA 초안, 인풋 작성기/,'retired consumers are not advertised');
assert.match(providerGui,/defaultPresetMissing[\s\S]*현재 연결로 정리[\s\S]*markGuiDirty\(\)/,'stale binding has explicit repair, never silent overwrite');
const selectHelper = between('const selectNode =', 'const checkboxNode =');
assert.match(selectHelper, /onChange\(nextValue, event\)[\s\S]*markGuiDirty/,
  'select changes must participate in the existing unsaved-change contract');

const saveGui = between('const saveGuiState = async', 'const providerChoices =');
assert.match(saveGui, /default_preset: runtime\.defaultPresetName/,
  'GUI save must persist the selected name through the existing plugin arg');

const presetResolution = between('const resolvePreset =', 'const callLLMWithPreset =');
assert.match(presetResolution, /const stagePreset = normalizeProviderPresetBindingName[\s\S]*const defaultPresetName = normalizeProviderPresetBindingName[\s\S]*const requestedName = stagePreset \|\| defaultPresetName/,
  'stage-specific named presets must continue to override the normalized shared default');
assert.doesNotMatch(presetResolution, /presets\?\.default|presets\.default/,
  'runtime preset resolution must not revive the retired default connection');

const presetChoices = between('const defaultPresetChoiceLabel =', 'const RUNTIME_PRESET_KEY_BY_STAGE =');
assert.match(presetChoices, /Gui\.state\?\.runtime\?\.defaultPresetName \|\| RISUAI_AUX_PRESET_NAME/,
  'an unset stage selector must derive its visible default from the concrete global connection');
assert.match(presetChoices, /return `\$\{presetDisplayName\(name\)\} \(기본\)`/,
  'the default option must name RisuAI Auxiliary Model instead of hiding it behind a generic global label');
assert.doesNotMatch(presetChoices, /전역 기본 프리셋 사용/,
  'the misleading generic stage-option label must not return');

const risuEditor=approved.extract(source,'buildApprovedAuxiliaryConnection');
assert.match(risuEditor,/RisuAI 보조 모델/);
assert.match(risuEditor,/mode: otherAx[\s\S]*staticModel 지정 안 함/);
assert.match(risuEditor,/플러그인 제공 보조 모델 허용/);
assert.match(risuEditor,/LibraProviderBridge\.testRisuAuxiliary\(\{risuAuxAllowPlugins:/);
assert.doesNotMatch(risuEditor,/providerField:['"](?:url|key|model)['"]/,'host-owned route cannot expose HTTP/key/model editing');
assert.match(providerGui,/disabled:canonicalProvider\(preset\.provider\)===RISUAI_AUX_PROVIDER/,'built-in auxiliary cannot be copied or deleted as HTTP preset');
assert.match(source, /RisuAI 보조 모델은 LIBRA 내장 연결이므로 이름을 바꿀 수 없습니다/);
assert.match(source, /RisuAI 보조 모델은 LIBRA 내장 연결이므로 삭제할 수 없습니다/);
assert.doesNotMatch(source, /bank\.default\s*=/,
  'legacy llm_* arguments must not synthesize a default connection');
assert.match(source, /key\.toLowerCase\(\) === 'default'/,
  'stored and imported reserved default rows must be filtered');

assert.match(source, /if \(Gui\.state\.runtime\.defaultPresetName === oldName\) Gui\.state\.runtime\.defaultPresetName = cleanName/,
  'renaming the selected preset must preserve the shared default binding');
assert.doesNotMatch(source, /if \(Gui\.state\.runtime\.defaultPresetName === target\) Gui\.state\.runtime\.defaultPresetName = fallback/,
  'deleting a preset must not silently overwrite the saved binding');
assert.match(providerGui, /orphanPresetBindings/,
  'deleted or missing bindings must remain visible as explicit orphans');

for (const intentionallyHidden of [
  'embedding_max_retries',
  'embedding_input_mode',
  'story_arc_preset',
  'enable_gui',
  'debug'
]) {
  assert.ok(!providerGui.includes(intentionallyHidden),
    `${intentionallyHidden} must not be added to the AI Connections GUI by this change`);
}

process.stdout.write('libra_global_default_provider_gui_contract_test: PASS\n');

