'use strict';
const assert = require('node:assert/strict');
function validate(name, report) {
  try {
    assert.ok(report && typeof report === 'object', 'missing report');
    for (const key of ['syncThrow', 'driverError', 'runError']) assert.ok(!report[key], key);
    for (const key of ['uncaught', 'unhandledRejection', 'consoleErrors']) assert.equal(report[key]?.length || 0, 0, key);
    if (name === 'risu_plugin_harness.js') assert.ok(Object.values(report.hooks || {}).some(value => Array.isArray(value) && value.length), 'no hooks');
    if (name === 'flashback_e2e_harness.js') {
      assert.ok(report.steps.length >= 5, 'conversation did not finish');
      for (const step of report.steps) assert.equal(step.ok, true, step.name);
    }
    if (name === 'hayaku_convo_harness.js') {
      assert.equal(report.steps.length, 6, 'missing turns');
      assert.ok(report.storage.pluginStorageKeys.some(key => key.includes('.ledger.')), 'no stored ledger');
      assert.equal(report.memoryBlocks.silverKey.present, true, 'no recalled memory');
      assert.equal(report.memoryBlocks.silverKey['mentions_은열쇠'], true, 'key recall');
      assert.equal(report.memoryBlocks.moneyOneChar['mentions_돈'], true, 'one syllable recall');
      assert.ok(Array.isArray(report.storedPacketRaws), 'no stored packets');
      assert.equal(report.storedPacketRaws.length, report.steps.length, 'a turn packet was not stored');
    }
    if (name === 'libra_convo_harness.js') {
      assert.equal(report.steps.length, 6, 'missing turns');
      assert.ok(report.llm.calls > 0, 'analysis never ran');
      for (const row of report.halfCommittedCheck) assert.ok(row.present && !row.pointsToGarbage, 'partial canonical commit');
      for (const row of report.canonicalRecords) assert.equal(row.rec_authError, false, 'error stored as memory');
      if (report.mode === 'FAIL_PATH') {
        assert.equal(report.llmHostFailCaught, true, 'failure not detected');
        assert.equal(report.canonicalRecords.length, 0, 'failed analysis committed');
        assert.equal(report.halfCommittedCheck.length, 0, 'failed analysis published reference');
      } else {
        assert.ok(report.canonicalRecords.some(row => row['rec_은열쇠'] && row['rec_돈']), 'missing canonical facts');
        assert.ok(report.halfCommittedCheck.length > 0, 'missing committed reference');
      }
    }
    return true;
  } catch (error) { console.error('HARNESS_ASSERTION_FAILED:', error.message); return false; }
}
module.exports = { validate };
