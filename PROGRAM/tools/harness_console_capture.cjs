'use strict';
// Shared console.error capture for the plugin harnesses.
//
// Every harness wraps console.error to record errors the PLUGIN logs, and the downstream
// assertion (tools/harness_assertions.cjs) requires that record to be EMPTY:
//
//     const origErr = console.error.bind(console);
//     console.error = (...a) => { record.consoleErrors.push(...) };
//     ...
//     assert.equal(report.consoleErrors?.length || 0, 0, 'consoleErrors');
//
// Node emits its own RUNTIME notices through that same channel. Measured on Node 24:
//
//     (node:29561) ExperimentalWarning: localStorage is not available because
//     --localstorage-file was not provided.
//     (Use `node --trace-warnings ...` to show where the warning was created)
//
// which the plugin triggers simply by touching localStorage. Counting a host notice as a plugin
// error made libra_convo_harness fail intermittently (measured: 'HARNESS_ASSERTION_FAILED:
// consoleErrors / 1 !== 0' under host load while passing standalone).
//
// This helper keeps runtime notices out of the plugin-error record while still recording
// everything the plugin actually logs.
const RUNTIME_NOTICE = /\bExperimentalWarning\b|\bWarning: /;
const RUNTIME_PROVENANCE = /\(node:\d+\)|--trace-warnings|--localstorage-file/;

const isNodeRuntimeNotice = text => {
  const value = String(text ?? '');
  return RUNTIME_NOTICE.test(value) && RUNTIME_PROVENANCE.test(value);
};

// Installs the capture on `record.consoleErrors`. Returns the original console.error so a harness
// can restore it when it tears down.
function installConsoleErrorCapture(record, options = {}) {
  const original = console.error.bind(console);
  const slice = options.slice || 300;
  const parts = options.parts || 4;
  console.error = (...args) => {
    try {
      const text = args.map(value => String(value)).slice(0, parts).join(' ');
      if (isNodeRuntimeNotice(text)) return;
      record.consoleErrors.push(text.slice(0, slice));
    } catch { /* the record is best-effort by design */ }
  };
  return original;
}

module.exports = { installConsoleErrorCapture, isNodeRuntimeNotice };
