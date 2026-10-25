'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pluginPath = path.resolve(__dirname, '..', 'plugins', 'HAYAKU_Locator_Continuity.js');
const source = fs.readFileSync(pluginPath, 'utf8');

assert.match(source, /const viewerRecordReanalysisPlan = record =>/);
assert.match(source, /const openHayakuSourceReanalysis = async/);
assert.match(source, /data-hayaku-reanalyze-record=/);
assert.ok(!source.includes('data-hayaku-regenerate-record'));
assert.ok(!source.includes('const viewerRegenerateRecord ='));
assert.ok(!source.includes('const viewerConfirmRecordRegeneration ='));
assert.ok(!source.includes('regenerateTurns: async'));
assert.match(source, /expandHayakuReanalysisKeys/);
assert.match(source, /sourceEditValidate:assertCurrent/);
assert.match(source, /native_recovery:targeted_regeneration_completed/);
assert.match(source, /hayakuNativeJobOverlay/);
assert.match(source, /hayakuNativeJobChip/);
assert.match(source, /cancelHayakuNativeJob/);
assert.match(source, /data-hayaku-regeneration-choice="keep_original"/);
assert.match(source, /data-hayaku-regeneration-choice="adopt_regenerated"/);
assert.match(source, /const resolveNativeRegenerationChoice = async/);
assert.match(source, /run\.state = options\.sourceEditValidate \? 'adopting' : 'awaiting_choice'/);
assert.match(source, /data-hayaku-select-variant=/);
assert.match(source, /const selectReplacementVariant = async/);
assert.match(source, /key\.startsWith\(HAYAKU_NATIVE_REGEN_RUN_KEY_PREFIX\)/,
  'regeneration run keys are classified as scope-owned storage');
assert.match(source, /pluginPrefixes:\[[^\]]*HAYAKU_NATIVE_REGEN_RUN_KEY_PREFIX/,
  'regeneration run keys participate in Librarian System storage routing');
assert.match(source, /expectedSchema = HAYAKU_NATIVE_REGEN_RUN_SCHEMA/,
  'server restore validates regeneration run schema and scope');
assert.match(source, /"old":"3\.0\.42","new":PLUGIN_VERSION,"pluginVersion":PLUGIN_VERSION/);

console.log('PASS hayaku_native_targeted_regeneration_ui_contract_test');
