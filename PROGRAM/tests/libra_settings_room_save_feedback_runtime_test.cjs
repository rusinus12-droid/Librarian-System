'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pluginPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, '..', 'plugins', 'LIBRA.js');
const source = fs.readFileSync(pluginPath, 'utf8');
const start = source.indexOf('const saveSettingsRoom = async () =>');
const end = source.indexOf('const clearStructuredSettings = async', start);
assert.notEqual(start, -1, 'saveSettingsRoom marker is missing');
assert.notEqual(end, -1, 'saveSettingsRoom end marker is missing');
const saveSource = source.slice(start, end);

const createHarness = ({ saveGuiState }) => {
  const events = [];
  const context = {
    Gui: {
      settingsRoomSaving: false,
      settingsRoomSaveStatus: '',
      settingsRoomSaveError: false
    },
    saveGuiState,
    renderSettingsGui: async () => { events.push('render'); return true; },
    syncGuiSaveControls: () => { events.push('sync'); },
    guiSetStatus: (message, isError, sticky) => events.push({ message, isError, sticky }),
    compact: (value) => String(value || ''),
    events
  };
  vm.createContext(context);
  new vm.Script(`${saveSource}\nthis.saveSettingsRoom = saveSettingsRoom;`).runInContext(context);
  return { context, events };
};

(async () => {
  {
    const harness = createHarness({ saveGuiState: async () => true });
    const result = await harness.context.saveSettingsRoom();
    assert.equal(result, true);
    assert.equal(harness.context.Gui.settingsRoomSaving, false);
    assert.equal(harness.context.Gui.settingsRoomSaveStatus, '설정을 저장했습니다.');
    assert.equal(harness.context.Gui.settingsRoomSaveError, false);
    assert.equal(harness.events.includes('render'), true);
    assert.deepEqual(harness.events.at(-2), { message: '설정을 저장했습니다. 다음 대화부터 적용됩니다.', isError: false, sticky: true });
  }

  {
    const harness = createHarness({ saveGuiState: async () => { throw new Error('SETTINGS_STALE_BASIS'); } });
    const result = await harness.context.saveSettingsRoom();
    assert.equal(result, false);
    assert.equal(harness.context.Gui.settingsRoomSaving, false);
    assert.match(harness.context.Gui.settingsRoomSaveStatus, /SETTINGS_STALE_BASIS/);
    assert.equal(harness.context.Gui.settingsRoomSaveError, true);
    assert.equal(harness.events.some(event => event?.isError === true), true);
  }

  process.stdout.write('libra_settings_room_save_feedback_runtime_test: PASS\n');
})().catch(error => {
  process.stderr.write(`libra_settings_room_save_feedback_runtime_test: FAIL: ${error?.stack || error}\n`);
  process.exitCode = 1;
});
