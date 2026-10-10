'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pluginPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, '..', 'plugins', 'LIBRA.js');
const source = fs.readFileSync(pluginPath, 'utf8');

const failures = [];
const check = (name, fn) => {
  try { fn(); } catch (error) { failures.push(`${name}: ${error?.message || error}`); }
};
const between = (start, end) => {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing start marker: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing end marker: ${end}`);
  return source.slice(from, to);
};

check('GUI load binds a durable semantic basis before editing', () => {
  const lifecycle = between('const applyGuiSettingsState =', 'const refreshModuleLoreCatalog =');
  assert.match(lifecycle, /if \(options\.preserveDirty === true && Gui\.dirty && Gui\.state\) return Gui\.state/,
    'background hydration must never replace a dirty draft');
  assert.match(lifecycle, /if \(typeof options\.basisHash === 'string'\) Gui\.settingsBasisHash = options\.basisHash/);
  assert.match(lifecycle, /const ensureGuiState = async[\s\S]*readSettingsPersistenceBasis\(\)[\s\S]*basisHash: basis\.semanticHash/,
    'normal GUI load must bind the durable aggregate basis');
  assert.match(lifecycle, /const revertGuiStateFromStorage = async[\s\S]*Runtime\.settings = null[\s\S]*readSettingsPersistenceBasis\(\)[\s\S]*keepDirty: false[\s\S]*basisHash: basis\.semanticHash/,
    'Revert must discard the draft and reload the last verified durable basis');
  assert.match(lifecycle, /const primeGuiStateFromRuntimeCache = \(\) =>[\s\S]*Gui\.settingsBasisHash = ''/,
    'fast cached first paint must not pretend to own a durable CAS basis');
});

check('background GUI reopen hydration fills a missing basis without overwriting edits', () => {
  const hydration = between('const hydrateSettingsGuiAfterOpen =', 'const scheduleSettingsGuiHydration =');
  assert.match(hydration, /if \(!fresh \|\| !Gui\.settingsBasisHash\)/);
  assert.match(hydration, /const basis = await readSettingsPersistenceBasis\(\)/);
  assert.match(hydration, /if \(Gui\.visible && openSerial === Gui\.openSerial && !Gui\.dirty\)/);
  assert.match(hydration, /preserveDirty: true, basisHash: basis\.semanticHash/);
});

check('GUI Save is one CAS-protected structured transaction', () => {
  const save = between('const saveGuiState = async () =>', 'const clearStructuredSettings = async');
  assert.match(save, /const expectedBasisHash = Gui\.settingsBasisHash \|\| \(await readSettingsPersistenceBasis\(\)\)\.semanticHash/);
  assert.match(save, /persistStructuredSettingsState\(\{[\s\S]*providers: state\.providers[\s\S]*backendToken: backendConfig\.token[\s\S]*runtime: runtimeRecord[\s\S]*agents: agentsRecord[\s\S]*prompts: promptsRecord/,
    'provider, backend token, runtime, agent/reference, and prompt bindings must share one transaction');
  assert.match(save, /expectedBasisHash,[\s\S]*label: 'gui_settings_save'/);
  assert.match(save, /await ensureGuiState\(true\)[\s\S]*Gui\.lastSettingsSaveError = ''/,
    'clean baseline is accepted only after durable readback and reload');
  assert.match(save, /catch \(error\)[\s\S]*Gui\.lastSettingsSaveError[\s\S]*Gui\.dirty = true[\s\S]*throw error/,
    'failed save preserves the dirty draft and exposes the failure');
  assert.doesNotMatch(save, /Promise\.all\s*\(\s*\[[\s\S]*(?:writeStoredPresetBank|writeRuntimeSettings|writeAgentSlots|writePromptOverrides)/,
    'GUI Save must not reintroduce parallel partial writes');
});

check('mode-local selections and references are serialized independently', () => {
  const save = between('const saveGuiState = async () =>', 'const clearStructuredSettings = async');
  assert.match(save, /response_family: responseModeState\.responseFamily/);
  assert.match(save, /libra_response_mode: responseModeState\.libraResponseMode/);
  assert.doesNotMatch(save, /gradia_writing_mode:/,'retired GRADIA writing mode is not serialized');
  assert.doesNotMatch(save, /input_writer_mode:/,'retired input writer mode is not serialized');
  assert.match(save, /selected_module_lore_ids: JSON\.stringify\(normalizeSelectedModuleLoreIds\(runtime\.selectedModuleLoreIds\)\)/);
  assert.match(save, /excluded_module_lore_ids: JSON\.stringify\(normalizeExcludedModuleLoreIds\(runtime\.excludedModuleLoreIds\)\)/);
  assert.match(save, /excluded_character_lore_ids: JSON\.stringify\(normalizeExcludedCharacterLoreIds\(runtime\.excludedCharacterLoreIds\)\)/);

  assert.doesNotMatch(source, /const buildInputAssistSettingsPanel\s*=/,'retired input writer controls are not revived');
});

check('runtime and provider normalization are semantic-idempotent', () => {
  const provider = between('const sanitizePreset =', 'const defaultUrlForProvider =');
  assert.match(provider, /const glmThinkingType = raw\.glm_thinking_type[\s\S]*\?\? thinkingType/);
  assert.match(provider, /glm_thinking_type: compact\(glmThinkingType, 80\)/,
    'a second normalization pass must not manufacture a different GLM value');

  const runtime = between('const parseRuntimeSettingsEnvelope =', 'const readAgentSlots = async');
  assert.match(runtime, /RUNTIME_SETTINGS_STORE_SCHEMA/);
  assert.match(runtime, /expectedSemanticHash/);
  assert.match(runtime, /runtime_settings_(?:envelope|semantic)_readback_failed/);
  assert.match(runtime, /rollbackStatus/);
});

if (failures.length) {
  process.stderr.write(`libra_settings_gui_lifecycle_contract_test: RED (${failures.length})\n`);
  for (const failure of failures) process.stderr.write(`- ${failure}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('libra_settings_gui_lifecycle_contract_test: PASS\n');
}
