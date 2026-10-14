'use strict';
// LIBRA memory engine routing policy (M01) — the ONLY place that decides which memory engine
// serves a recall request, and the record of that decision.
//
// 1. Unified is the only serving engine. Former legacy/shadow selections are
//    compatibility inputs, migrated to unified and disclosed in the decision.
// 2. Unknown modes are refused; qualification metadata never selects an old engine.
// 3. The resolved decision carries its own provenance (source / defaultApplied / qualification), so
//    a result can state which engine served it instead of inheriting an inline literal.
//
// The marked block below is embedded verbatim in PROGRAM/plugins/LIBRA.js; the parity test
// (tests/libra_memory_engine_mode_test.cjs) compares both copies so they cannot drift.

/* LIBRA_MEMORY_ENGINE_MODE_POLICY:START */
const MEMORY_ENGINE_MODES = Object.freeze(['unified']);
const RETIRED_MEMORY_ENGINE_MODES = Object.freeze(['legacy', 'shadow']);
const DEFAULT_MEMORY_ENGINE_MODE = 'unified';
const DEFAULT_MODE_OPEN_GATES = Object.freeze(['E4']);
const memoryEngineModeText = value => String(value == null ? '' : value).trim();
const isKnownMemoryEngineMode = value => [...MEMORY_ENGINE_MODES, ...RETIRED_MEMORY_ENGINE_MODES].includes(memoryEngineModeText(value));
const normalizeMemoryEngineMode = (value, options = {}) => {
  const raw = memoryEngineModeText(value);
  if (!raw) return DEFAULT_MEMORY_ENGINE_MODE;
  if (!isKnownMemoryEngineMode(raw)) {
    const error = new TypeError('LIBRA_MEMORY_ENGINE_MODE_INVALID:' + raw);
    error.code = 'LIBRA_MEMORY_ENGINE_MODE_INVALID';
    error.value = raw;
    error.allowed = MEMORY_ENGINE_MODES.slice();
    throw error;
  }
  return 'unified';
};
const resolveMemoryEngineMode = (options = {}) => {
  const requestRaw = memoryEngineModeText(options.requestValue);
  const settingRaw = memoryEngineModeText(options.settingValue);
  const declared = requestRaw || settingRaw;
  const mode = normalizeMemoryEngineMode(declared);
  const source = requestRaw ? 'request' : (settingRaw ? 'setting' : 'default');
  return {
    schema: 'libra.memory_engine_decision.v1',
    mode,
    source,
    declared: declared || null,
    defaultApplied: source === 'default',
    retiredSelection: RETIRED_MEMORY_ENGINE_MODES.includes(declared) ? declared : null,
    qualification: 'unqualified_until_E3_E4'
  };
};
const stampMemoryEngineDecision = (result, decision, extra = {}) => {
  if (!result || typeof result !== 'object') return result;
  if (!result.diagnostics || typeof result.diagnostics !== 'object') result.diagnostics = {};
  result.diagnostics.memoryEngine = Object.assign({}, decision, extra);
  return result;
};
/* LIBRA_MEMORY_ENGINE_MODE_POLICY:END */

module.exports = Object.freeze({
  MEMORY_ENGINE_MODES,
  RETIRED_MEMORY_ENGINE_MODES,
  DEFAULT_MEMORY_ENGINE_MODE,
  DEFAULT_MODE_OPEN_GATES,
  isKnownMemoryEngineMode,
  normalizeMemoryEngineMode,
  resolveMemoryEngineMode,
  stampMemoryEngineDecision
});
