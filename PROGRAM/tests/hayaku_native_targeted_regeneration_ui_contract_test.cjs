'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pluginPath = path.resolve(__dirname, '..', 'plugins', 'HAYAKU_Locator_Continuity.js');
const source = fs.readFileSync(pluginPath, 'utf8');

assert.match(source, /const viewerRecordRegenerationPlan = record =>/);
assert.match(source, /storageRecordTurnRange\(record\)/);
assert.match(source, /data-hayaku-regenerate-record=/);
assert.match(source, /const viewerConfirmRecordRegeneration = \(record, plan\) =>/);
assert.match(source, /const viewerRegenerateRecord = async recordIdInput =>/);
assert.match(source, /runNativeTargetedRegeneration\(\{[\s\S]*replacementRecordIds: \[plan\.recordId\][\s\S]*replaceExisting: true/);
assert.match(source, /모든 새 패킷이 검증된 경우에만 기존 레코드를 tombstone 처리하고 한 번의 원장 트랜잭션으로 교체합니다/);
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
