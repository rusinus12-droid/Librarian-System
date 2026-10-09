'use strict';
// Observation-only lexical access. Shipped source has no test exports.
const path = require('node:path');
const assert = require('node:assert/strict');
const { runtime } = require('./libra_typed_recall_queue_test.cjs');
const plain = value => value == null ? value : JSON.parse(JSON.stringify(value));
const profile = (model, extra = {}) => ({ provider: 'openai', model, key: 'synthetic-test-only', url: 'https://synthetic.invalid/v1/chat/completions', temp: 0, timeout: 10000, ...extra });
async function fixture(options = {}) {
  const names = [
    'normalizeCommonAnalysisSettings', 'resolveCommonAnalysisPreset', 'normalizeLLMPresetMap',
    'normalizeSettingsAliases', 'canonicalSettingsForStorage', 'writeCommonPluginSettings', 'getLLMProfileConfig',
    'resolveLLMRouteProfile', 'resolveAnalysisProfile', 'buildFastAnalysisProfile',
    'captureWmAnalysisConfig', 'isWmAnalysisConfigCurrent', 'LLMProvider', 'LLMProviderCallTest', 'AutoProvider',
    'DEFAULT_LLM_ROUTE_PROFILES', 'updateConfigFromArgs', 'MemoryEngine',
    'DurableTurnLedger', 'buildTurnMaintenanceRecord', 'runTurnMaintenanceRecord',
    'WmAnalysisSnapshotOwner', 'upsertPendingTurnMaintenanceRecord', 'getPendingTurnMaintenanceRecords', 'ResourceGovernor',
    'classifyWmAnalysisAdmission', 'buildPublicSettingsExport'
  ];
  const r = await runtime(options.shared || null, {
    ...options,
    dist: options.dist || process.env.WM_CHECKSUM_DIST || path.resolve(__dirname, '../dist/LIBRA World Manager Full.js'),
    transformCode(code) {
      const end = code.lastIndexOf('})();');
      assert(end >= 0, 'existing IIFE observation seam');
      const fields = names.map(n => `${n}:typeof ${n}==='undefined'?null:${n}`).join(',');
      return code.slice(0, end) + `\n;globalThis.__WM_COMMON_AI_TEST__={${fields}};\n` + code.slice(end);
    }
  });
  r.ai = r.context.__WM_COMMON_AI_TEST__;
  assert(r.ai && typeof r.ai.normalizeSettingsAliases === 'function', 'existing settings runtime initialized');
  return r;
}
function required(api, name) {
  assert.equal(typeof api[name], 'function', `${name} must be implemented in the real artifact`);
  return api[name];
}
module.exports = { fixture, profile, plain, required };
