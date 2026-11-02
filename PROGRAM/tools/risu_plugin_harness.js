// RisuAI contract-backed host harness — loads ONE MemorySuite plugin per process and reports.
// Usage: node risu_plugin_harness.js "<absolute plugin path>"
// Backed by the reviewed RisuAI Compatibility Pack (PROGRAM/contracts/risuai/) via risu_contract_host.cjs.
// Unmapped RisuAI API access fails immediately with UNMAPPED_RISUAI_API_CALL.
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { createContractBackedHostCluster } = require('./risu_contract_host.cjs');

const pluginPath = process.argv[2];
if (!pluginPath) { console.error('no plugin path'); process.exit(2); }

// ---- crash capture: nothing may slip past ----
const captured = { uncaught: [], unhandled: [] };
process.on('uncaughtException', (err) => {
  captured.uncaught.push({
    code: err && err.code || null,
    message: String(err && err.message || err),
    stack: err && err.stack || null
  });
});
process.on('unhandledRejection', (reason) => {
  const e = reason instanceof Error ? reason : new Error(String(reason));
  captured.unhandled.push({
    code: reason && reason.code || null,
    message: String(e.message),
    stack: e.stack || null
  });
});

const src = fs.readFileSync(pluginPath, 'utf8');
const cluster = createContractBackedHostCluster({
  databaseConsent: false // simulates "no db consent" — plugins must handle this gracefully
});

let hostHandle = null;
let syncThrow = null;

try {
  hostHandle = cluster.createHostForPlugin({
    sourceText: src,
    filename: path.basename(pluginPath)
  });
} catch (e) {
  syncThrow = {
    code: e && e.code || null,
    message: String(e && e.message || e),
    stack: e && e.stack || null
  };
}

const Risuai = hostHandle ? hostHandle.api : {};
const record = hostHandle ? hostHandle.record : {
  hooks: { chatListeners: [], replacers: [], scriptHandlers: [], ttsPre: 0, ttsPost: 0 },
  ui: { settings: [], buttons: [], unregistered: [] },
  ipc: { channels: [] },
  network: { nativeFetch: 0, risuFetch: 0, urls: [] },
  llm: { calls: 0, lastMessages: null },
  providers: [],
  mcps: [],
  consoleErrors: [],
  unmappedCalls: []
};

// Expose under every alias the plugins probe for.
globalThis.Risuai = Risuai;
globalThis.RisuAI = Risuai;
globalThis.risuai = Risuai;
globalThis.risuApi = Risuai;
globalThis.risuAPI = Risuai;

if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;

const { installConsoleErrorCapture } = require('./harness_console_capture.cjs');
const origErr = installConsoleErrorCapture(record);

if (!syncThrow) {
  try {
    vm.runInThisContext(src, { filename: pluginPath });
  } catch (e) {
    syncThrow = {
      code: e && e.code || null,
      message: String(e && e.message || e),
      stack: e && e.stack || null
    };
  }
}

setTimeout(async () => {
  console.error = origErr;
  const diag = (globalThis.__librarianDiag && typeof globalThis.__librarianDiag.snapshot === 'function')
    ? globalThis.__librarianDiag.snapshot() : null;

  const exposedGlobals = Object.getOwnPropertyNames(globalThis)
    .filter((k) => /^__(LIBRA|HAYAKU|Flashback|librarian|MemorySuite)/i.test(k) || /LIBRA|HAYAKU|Flashback/i.test(k))
    .filter((k) => !['RisuAI'].includes(k))
    .slice(0, 60);

  const pluginStorageKeys = await cluster.pluginStorage.keys();
  const safeLocalStorageKeys = await cluster.safeLocalStorage.keys();
  const localPluginStorageKeys = [...cluster.localPluginStorageFactory.__backingForage.keys()]
    .map(k => k.replace(/^safe_plugin_/, ''));

  const out = {
    plugin: path.basename(pluginPath),
    pluginName: hostHandle ? hostHandle.pluginEntry.name : null,
    contractBackedHost: true,
    syncThrow,
    uncaught: captured.uncaught,
    unhandledRejection: captured.unhandled,
    unmappedApiCalls: record.unmappedCalls || [],
    hooks: record.hooks,
    ui: record.ui,
    ipc: record.ipc,
    network: {
      nativeFetch: record.network.nativeFetch,
      risuFetch: record.network.risuFetch,
      lastUrls: record.network.urls
    },
    llm: {
      calls: record.llm.calls,
      lastMessages: record.llm.lastMessages
    },
    providers: record.providers,
    mcps: record.mcps,
    consoleErrors: record.consoleErrors.slice(0, 20),
    exposedGlobals,
    pluginStorageKeys,
    safeLocalStorageKeys,
    localPluginStorageKeys,
    librarianDiag: diag,
    argsParsed: hostHandle ? hostHandle.pluginEntry.realArg : {}
  };
  process.stdout.write('\n===HARNESS_RESULT_JSON_BEGIN===\n' + JSON.stringify(out, null, 2) + '\n===HARNESS_RESULT_JSON_END===\n');
  const valid = require('./harness_assertions.cjs').validate('risu_plugin_harness.js', out)
    && (out.unmappedApiCalls.length === 0);
  process.exit(valid ? 0 : 1);
}, 2500);
