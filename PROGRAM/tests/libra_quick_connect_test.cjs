'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../plugins/LIBRA.js'),'utf8');
assert.doesNotMatch(source,/const (?:runLibraQuickConnect|buildLibraConnectionSetupCard|buildLibraQuickConnectBody|buildLibraLiveContextSettingsPanel|detectLibraKeyProvider)\s*=/);
assert.ok(source.includes("card('생성 AI 프리셋'"),'preset editor remains');
assert.ok(source.includes("card('임베딩'"),'embedding settings remain');
assert.ok(!source.includes("'[RECENT COMPLETED DIALOGUE]\\n' +"),'direct raw-dialogue append is removed');
console.log('libra_quick_connect_test: PASS (redundant connection form and recent-dialogue controls retired; presets retained)');
