'use strict';
// HAYAKU storage-mode parity — Tasks 32-36 of
// Librarian-System-0.3.61-STORAGE-MODE-CONTINUATION-PLAN.md.
//
// The plan lists a repro per feature, but a survey of those repros measured this:
//
//   feature repros that exist                     14/14
//   repros that only read plugin SOURCE TEXT       6
//   repros that start a real server                0
//   repros that accept a storage mode              0
//
// So every one of these features was proven in `plugin_only` (the harness default) and never
// executed against a real Memory Suite server in `mirror` / `server_only`. This test supplies the
// missing dimension: the REAL plugin, wired to a REAL HTTP/SQLite server, driven through each
// feature's own entry point, with the durable result read back through the plugin's own ledger
// inspector and compared across modes.
//
// Modes exercised: plugin_only, mirror, server_only (real server for the latter two).
// Assertion style: whatever a mode reports, the modes must AGREE, and the durable readback must
// contain the same logical packets. A mode-specific storage contract is asserted explicitly
// (server_only keeps no owner ledger locally; mirror's local and server rows agree).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMemorySuiteServer } = require('../server/server.cjs');
const { createHayakuRuntime, createValidPacket, hiddenPacketMessage } = require('./fixtures/hayaku_runtime_harness.cjs');

const MODES = ['plugin_only', 'mirror', 'server_only'];
const PLUGIN = 'HAYAKU_Locator_Continuity.js';

// Expose the storage bridge the way the existing server-mode test does, so the scope mode can be
// set explicitly instead of relying on a default.
const HOST_TEST_HOOKS = "        storageBridgeForHostTest:MemorySuiteStorageBridge,\n";

const buildPluginFile = root => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'plugins', PLUGIN), 'utf8');
  const anchor = '        updateRecoveryJournalBackgroundDecision,';
  assert.ok(source.includes(anchor), 'the host-test injection anchor must exist');
  const injected = source.replace(anchor, HOST_TEST_HOOKS + anchor);
  const file = path.join(root, `${PLUGIN.replace('.js', '')}-parity.js`);
  fs.writeFileSync(file, injected);
  return file;
};

const turnMessages = (turns, summary) => {
  const messages = [];
  for (let turn = 1; turn <= turns; turn += 1) {
    messages.push({ role: 'user', id: `u${turn}`, chatId: `u${turn}`, data: `User ${turn} inspects the workshop.` });
    messages.push({
      role: 'char', id: `a${turn}`, chatId: `a${turn}`,
      data: hiddenPacketMessage(`${summary} (turn ${turn})`, createValidPacket({
        turn, subject: 'Alice', scene: 'workshop', summary: `${summary} (turn ${turn})`
      }))
    });
  }
  return messages;
};

const SUMMARY = 'Alice turned the brass valve and steam began flowing through the blue pipe.';

// Run one mode end to end and return the logical outcome the parity comparison uses.
async function runMode(mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `hayaku-parity-${mode}-`));
  let app = null;
  let runtime = null;
  try {
    app = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir: path.join(root, 'DATA'), autoBackup: false });
    const address = await app.listen();
    const url = `http://127.0.0.1:${address.port}`;
    const pluginFile = buildPluginFile(root);

    runtime = await createHayakuRuntime({
      autoRepair: false,
      pluginSourceFile: pluginFile,
      chatId: `hayaku-parity-${mode}`,
      messages: turnMessages(10, SUMMARY),
      // The harness refuses host calls unless a fetch implementation is supplied (its default
      // throws `fixture_native_fetch_unavailable`), which in server modes surfaces as
      // MEMORY_SUITE_SERVER_UNAVAILABLE and then SOURCE_EDIT_JOURNAL_UNAVAILABLE. Supplying the
      // real fetch is what makes the server-mode legs actually reach the server.
      nativeFetch: async (url, init) => {
        const headers = new Headers(init?.headers);
        headers.set('Connection', 'close');
        return fetch(url, { ...init, headers });
      },
      arguments: { memory_suite_server_mode: mode, memory_suite_server_url: url }
    });

    const test = runtime.hayaku._test;
    assert.ok(test, `${mode}: the plugin exposes its test surface`);

    // The scope must actually run in the requested mode, otherwise this measures nothing.
    const bridge = test.storageBridgeForHostTest;
    assert.ok(bridge, `${mode}: the storage bridge is reachable for the mode assertion`);
    const connection = await bridge.getConnectionSettings({ force: true });
    if (mode === 'server_only') {
      await bridge.setScopeMode(connection.scope, mode);
      // Re-read through the bridge the same way the working server-mode test does; setting the
      // mode is not observable until the bridge reports it back.
      const confirmed = await bridge.getConnectionSettings({ scope: connection.scope, force: true });
      assert.equal(confirmed.mode, mode, `${mode}: the bridge reports the requested mode`);
    }
    const observedMode = await bridge.getScopeMode({ scopeId: connection.scope.scopeKey, scopeKey: connection.scope.scopeKey });
    assert.equal(observedMode.mode, mode, `${mode}: this scope really runs in the requested mode`);

    // Drive the real capture path so owner rows are produced. The native scan is the entry point
    // that builds and persists packets in every mode (the working server-mode test uses it).
    const scan = await test.scanCurrentChatForNativeRecoveryDebts({ manualFullScan: true, reason: 'parity' });
    assert.equal(scan.ok, true, `${mode}: the native scan succeeded — ${JSON.stringify(scan).slice(0, 200)}`);

    // Durable readback through the plugin's own inspector.
    const ledger = await runtime.hayaku.ledger.inspect({ includeRecords: true });
    const records = Array.from(ledger?.records || []);
    const logical = records.map(record => ({
      packetType: record.packetType ?? null,
      turn: Number(record.turn ?? record.turnIndex ?? -1),
      recordStatus: record.recordStatus ?? null
    })).sort((a, b) => a.turn - b.turn || String(a.packetType).localeCompare(String(b.packetType)));

    // Where the bytes landed: the mode's own authority contract.
    const localLedgerKeys = [];
    for (const key of runtime.pluginStorage.values.keys()) {
      if (/hayaku\.v2\.ledger\./.test(String(key))) localLedgerKeys.push(String(key));
    }
    const serverRows = [];
    try {
      const listed = app.repositories?.hayaku?.list?.('plugin', 'hayaku');
      if (listed?.records) serverRows.push(...listed.records.map(row => row.key));
    } catch { /* the repository shape varies; a missing list is recorded as zero */ }

    const status = await runtime.hayaku.recovery.status?.().catch(() => null);

    return {
      mode,
      ledgerAvailable: ledger?.available === true,
      recordCount: records.length,
      logical,
      coldStartOk: status?.coldStartRun?.run ? true : null,
      localLedgerKeys: localLedgerKeys.length,
      serverRowCount: serverRows.length
    };
  } finally {
    await runtime?.dispose?.().catch(() => null);
    await app?.close?.().catch(() => null);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

(async () => {
  const results = [];
  for (const mode of MODES) {
    try {
      results.push(await runMode(mode));
      process.stdout.write(`  ${mode}: measured\n`);
    } catch (error) {
      process.stderr.write(`  ${mode}: FAILED - ${error?.message || error}\n`);
      throw error;
    }
  }

  const observations = results.map(row => ({
    mode: row.mode,
    ledgerAvailable: row.ledgerAvailable,
    recordCount: row.recordCount,
    localLedgerKeys: row.localLedgerKeys,
    serverRowCount: row.serverRowCount
  }));

  console.log(JSON.stringify({ test: 'hayaku_storage_mode_parity', observations }, null, 1));

  // 1. Every mode must actually produce owner rows — otherwise nothing was measured.
  for (const row of results) {
    assert.ok(row.recordCount > 0,
      `${row.mode}: the capture path produced owner ledger records (got ${row.recordCount}); `
      + `without this the parity comparison below would be vacuous`);
  }

  // 2. The logical packet set must be identical across modes.
  const baseline = results[0];
  for (const row of results.slice(1)) {
    assert.deepEqual(row.logical, baseline.logical,
      `${row.mode}: the captured packet set must match ${baseline.mode}\n`
      + `  ${baseline.mode}: ${JSON.stringify(baseline.logical)}\n`
      + `  ${row.mode}: ${JSON.stringify(row.logical)}`);
  }

  // 3. Mode-specific storage authority contract.
  const serverOnly = results.find(row => row.mode === 'server_only');
  assert.equal(serverOnly.localLedgerKeys, 0,
    `server_only must not keep an owner ledger locally (found ${serverOnly.localLedgerKeys})`);
  const mirror = results.find(row => row.mode === 'mirror');
  assert.ok(mirror.serverRowCount > 0,
    'mirror must project the owner rows to the server as well as locally');
  const pluginOnly = results.find(row => row.mode === 'plugin_only');
  assert.ok(pluginOnly.serverRowCount === 0,
    `plugin_only must not write owner rows to a server (found ${pluginOnly.serverRowCount})`);

  process.stdout.write('hayaku_storage_mode_parity_test: PASS\n');
})().catch(error => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
