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

check('settings room save has an explicit feedback lifecycle', () => {
  const save = between('const saveSettingsRoom = async () =>', 'const clearStructuredSettings = async');
  assert.match(save, /if \(Gui\.settingsRoomSaving === true\) return false/);
  assert.match(save, /Gui\.settingsRoomSaveStatus = '설정 저장 중…'/);
  assert.match(save, /if \(await saveGuiState\(\) !== true\) throw new Error\('settings_save_not_confirmed'\)/);
  assert.match(save, /Gui\.settingsRoomSaveStatus = '설정을 저장했습니다\.'/);
  assert.match(save, /await renderSettingsGui\(\)/);
  assert.match(save, /guiSetStatus\(/);
  assert.match(save, /catch \(error\)[\s\S]*Gui\.settingsRoomSaveError = true[\s\S]*return false/);
  assert.match(save, /finally \{[\s\S]*Gui\.settingsRoomSaving = false[\s\S]*syncGuiSaveControls\(\)/);
});

check('settings room button calls the feedback wrapper', () => {
  const nativeRoom = between('const buildBookNativeSettingsRoom =', 'const buildBookSettingsPanel =');
  const saveBar = between('const buildBookSaveBar =', 'const resetBookWriting');
  assert.match(saveBar, /dataset: \{ settingsRoomSave: 'true' \}/);
  assert.match(saveBar, /onClick: \(\) => void saveSettingsRoom\(\)/);
  assert.match(saveBar, /settingsRoomSaveStatus: 'true'/);
  assert.match(saveBar, /disabled: Gui\.settingsRoomSaving === true/,
    'the visible settings room action is disabled only while its save is in flight');
  assert.match(nativeRoom, /buildBookSaveBar\(\)/, 'the native settings room owns the shared save bar');
  assert.doesNotMatch(saveBar, /onClick:\s*\(\)\s*=>\s*void saveGuiState\(\)/,
    'the visible settings room action must not discard save errors');
});

check('feedback controls are synchronized without changing dirty semantics', () => {
  const sync = between('const syncGuiSaveControls = () =>', 'const markGuiDirty =');
  assert.match(sync, /\[data-settings-room-save\]/);
  assert.match(sync, /Gui\.settingsRoomSaving === true/);
  assert.match(sync, /\[data-settings-room-save-status\]/);
  assert.match(sync, /Gui\.settingsRoomSaveError === true/);
});

if (failures.length) {
  process.stderr.write(`libra_settings_room_save_feedback_contract_test: RED (${failures.length})\n`);
  for (const failure of failures) process.stderr.write(`- ${failure}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('libra_settings_room_save_feedback_contract_test: PASS\n');
}
