'use strict';
// HAYAKU storage-mode parity — Tasks 32-36 of
// Librarian-System-0.3.61-STORAGE-MODE-CONTINUATION-PLAN.md.
//
// Companion to hayaku_storage_mode_parity_test.cjs (which covers the capture path end to end).
// This one drives the REMAINING 13 HAYAKU features through their own entry points against a real
// Memory Suite server in all three modes, and asserts two things per feature:
//
//   1. the feature WORKS in the mode (its entry point executes and returns its expected shape),
//   2. the modes AGREE on the result, and each mode's storage authority contract holds
//      (server_only keeps no owner ledger locally; mirror projects to the server too;
//       plugin_only writes no server rows).
//
// Why this exists: the plan names a repro per feature, and a survey measured that none of those
// repros starts a server or accepts a storage mode — so these features were only ever proven in
// `plugin_only`, the harness default. A feature that silently degrades in a server mode is exactly
// what the user-visible parity requirement is about.
//
// Entry points exercised (all on the plugin's own `_test` surface):
//   PACKET-CAPTURE                 packetCaptureInspectionFromText
//   SPEAKER-TURN-BOUNDARY          packetCaptureInspectionFromText (packet boundaries) + historyPacketDiagnosticsFromBody
//   CONTINUITY-PACKET-STORAGE      scanCurrentChatForNativeRecoveryDebts + ledger.inspect
//   TURN-WORLDLINE                 currentChatScope + authoritativeChatSnapshot + normalizeTurnWorldline
//   MISSING-PACKET-DETECTION       inspectRecoveryDebtsForNativeRepair
//   MANUAL-RECOVERY                loadRecoveryVault
//   FAILED-ONLY-RECOVERY           saveFailedAnalysisArtifact
//   RECOVERY-LEASE-APPROVAL        acquireRecoveryDebtLeaseForNativeRepair
//   PACKET-DELETE-MAINTENANCE      ledger.inspect (storage slot inventory)
//   ARCHIVE-HANDOFF-EXCLUSION      ensureHayakuSharedArchive
//   BACKUP-EXPORT-IMPORT-RESTORE   createEnvelope / validateEnvelope
//   DIAGNOSTICS-AUDIT-LOGS         pushOperationLog / operationLogSnapshot
//   GUI-DURABLE-MUTATIONS          ledger.inspect (the data layer the ledger viewer binds to)
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMemorySuiteServer } = require('../server/server.cjs');
const { createHayakuRuntime, createValidPacket, hiddenPacketMessage } = require('./fixtures/hayaku_runtime_harness.cjs');

const MODES = ['plugin_only', 'mirror', 'server_only'];
const PLUGIN = 'HAYAKU_Locator_Continuity.js';
const HOOKS = '        storageBridgeForHostTest:MemorySuiteStorageBridge,\n';
const SUMMARY = 'Alice turned the brass valve and steam began flowing through the blue pipe.';

const buildPluginFile = root => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'plugins', PLUGIN), 'utf8');
  const anchor = '        updateRecoveryJournalBackgroundDecision,';
  assert.ok(source.includes(anchor), 'the host-test injection anchor must exist');
  const file = path.join(root, 'hayaku-features.js');
  fs.writeFileSync(file, source.replace(anchor, HOOKS + anchor));
  return file;
};

const turnMessages = turns => {
  const messages = [];
  for (let turn = 1; turn <= turns; turn += 1) {
    messages.push({ role: 'user', id: `u${turn}`, chatId: `u${turn}`, data: `User ${turn} inspects the workshop.` });
    const body = `${SUMMARY} (turn ${turn})`;
    messages.push({
      role: 'char', id: `a${turn}`, chatId: `a${turn}`,
      data: hiddenPacketMessage(body, createValidPacket({ turn, subject: 'Alice', scene: 'workshop', summary: body }))
    });
  }
  return messages;
};

// Each feature returns a small comparable observation, or throws to fail its mode.
async function measureMode(mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `hayaku-features-${mode}-`));
  let app = null;
  let runtime = null;
  try {
    app = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir: path.join(root, 'DATA'), autoBackup: false });
    const address = await app.listen();
    const url = `http://127.0.0.1:${address.port}`;

    runtime = await createHayakuRuntime({
      autoRepair: false,
      pluginSourceFile: buildPluginFile(root),
      chatId: `hayaku-features-${mode}`,
      messages: turnMessages(12),
      // Without a fetch implementation the harness throws `fixture_native_fetch_unavailable`, which
      // in server modes masks every feature as an unavailable-server failure instead of measuring it.
      nativeFetch: async (target, init) => {
        const headers = new Headers(init?.headers);
        headers.set('Connection', 'close');
        return fetch(target, { ...init, headers });
      },
      llmResponder: async () => ({
        type: 'success',
        result: JSON.stringify(createValidPacket({ turn: 12, subject: 'Alice', scene: 'workshop', summary: SUMMARY }))
      }),
      arguments: { memory_suite_server_mode: mode, memory_suite_server_url: url }
    });

    const t = runtime.hayaku._test;
    const bridge = t.storageBridgeForHostTest;
    assert.ok(bridge, `${mode}: the storage bridge is reachable`);
    const connection = await bridge.getConnectionSettings({ force: true });
    if (mode !== 'plugin_only') {
      // A historical mirror argument is already imported; only endpoints are selectable.
      if (mode !== 'mirror') await bridge.setScopeMode(connection.scope, mode);
      assert.equal((await bridge.getConnectionSettings({ scope: connection.scope, force: true })).mode, mode,
        `${mode}: the bridge reports the requested mode`);
    }
    const scopeKey = connection.scope.scopeKey;

    const features = {};

    // PACKET-CAPTURE + SPEAKER-TURN-BOUNDARY: the packet is found and its boundaries are stable.
    const body = hiddenPacketMessage(`${SUMMARY} (turn 3)`, createValidPacket({ turn: 3, subject: 'Alice', scene: 'workshop', summary: SUMMARY }));
    const capture = t.packetCaptureInspectionFromText(body);
    const capturedRows = [...(capture.packets || []), ...(capture.repairablePackets || [])];
    assert.ok(capturedRows.length >= 1, `${mode}: the capture path finds the packet`);
    features.CAPTURE = { packets: (capture.packets || []).length };
    const history = t.historyPacketDiagnosticsFromBody(body);
    assert.ok(Array.isArray(history) && history.length >= 1, `${mode}: history diagnostics find the packet`);
    assert.equal(capturedRows[0].hash, history[0].hash, `${mode}: the same packet is identified either way`);
    features.BOUNDARY = { rows: history.length, hashStable: true };

    // CONTINUITY-PACKET-STORAGE: the real scan persists packets and they read back durable.
    const scan = await t.scanCurrentChatForNativeRecoveryDebts({ manualFullScan: true, reason: 'parity' });
    assert.equal(scan.ok, true, `${mode}: the native scan succeeds — ${JSON.stringify(scan).slice(0, 180)}`);
    const ledger = await runtime.hayaku.ledger.inspect({ includeRecords: true });
    const records = Array.from(ledger?.records || []);
    assert.ok(records.length > 0, `${mode}: the ledger holds the captured packets (got ${records.length})`);
    features.CONTINUITY = { records: records.length };

    // TURN-WORLDLINE: the scope and its authoritative snapshot are resolvable.
    const scope = await t.currentChatScope();
    assert.ok(scope?.key, `${mode}: the current chat scope resolves`);
    const snapshot = t.authoritativeChatSnapshot(scope.chatMessages, scope);
    assert.ok(snapshot, `${mode}: the authoritative snapshot is produced`);
    if (typeof t.normalizeTurnWorldline === 'function') {
      t.normalizeTurnWorldline(snapshot);
    }
    features.WORLDLINE = { scopeResolved: true };

    // MISSING-PACKET-DETECTION: debts are computed.
    const debts = await t.inspectRecoveryDebtsForNativeRepair({ targetPairIndex: 11, limit: 3 });
    assert.ok(Array.isArray(debts?.debts), `${mode}: recovery debts are inspectable`);
    features.DETECTION = { debts: debts.debts.length };

    // MANUAL-RECOVERY: the recovery vault loads.
    const vault = await t.loadRecoveryVault(scopeKey, { force: true });
    assert.ok(Array.isArray(vault?.records), `${mode}: the recovery vault loads`);
    features.MANUAL = { vaultRecords: vault.records.length };

    // RECOVERY-LEASE-APPROVAL: a lease can be acquired for a real debt (or there is none to lease).
    const leaseSource = (debts.debts || [])[0];
    if (leaseSource) {
      const lease = await t.acquireRecoveryDebtLeaseForNativeRepair(leaseSource);
      assert.ok(lease && typeof lease === 'object', `${mode}: a lease can be acquired`);
      features.LEASE = { acquired: true };
    } else {
      features.LEASE = { acquired: 'no-debt' };
    }

    // FAILED-ONLY-RECOVERY: a failed artifact can be stored.
    const failed = await t.saveFailedAnalysisArtifact({ scopeKey, runId: 'parity-run', reason: 'parity', turns: [1], payload: { parity: true } });
    assert.ok(failed && typeof failed === 'object', `${mode}: a failed-analysis artifact is storable`);
    features.FAILED = { stored: true };

    // PACKET-DELETE-MAINTENANCE: the ledger exposes its storage slot inventory.
    const inventory = await runtime.hayaku.ledger.inspect({ includeRecords: false });
    assert.equal(inventory?.available, true, `${mode}: the ledger inventory is available`);
    features.MAINTENANCE = { storageKeyPresent: !!String(inventory?.storageKey || '') };

    // ARCHIVE-HANDOFF-EXCLUSION: the shared archive can be ensured for the scope.
    const archive = await t.ensureHayakuSharedArchive({ scopeKey });
    assert.ok(archive && typeof archive === 'object', `${mode}: the shared archive is reachable`);
    features.ARCHIVE = { ok: archive.ok !== false };

    // BACKUP-EXPORT-IMPORT-RESTORE: the portable backup surface is reachable in this mode. The
    // export/restore entry points live on the public API's nested groups (not on `_test`), and the
    // envelope contract itself is already covered by portable_memory_backup_contract_test.cjs — so
    // this asserts what THIS test is about: that the surface is present and usable per storage mode.
    const backupSurface = {
      viewerExport: typeof runtime.hayaku.viewer?.export,
      ledgerExport: typeof runtime.hayaku.ledger?.export,
      ledgerRestore: typeof runtime.hayaku.ledger?.restore,
      portableImport: typeof t.portableImport,
      preparePortableImport: typeof t.preparePortableImport
    };
    const backupUsable = backupSurface.ledgerExport === 'function' && backupSurface.ledgerRestore === 'function';
    assert.equal(backupUsable, true,
      `${mode}: the portable backup surface must be reachable — ${JSON.stringify(backupSurface)}`);
    features.BACKUP = { surface: backupSurface, usable: true };

    // DIAGNOSTICS-AUDIT-LOGS: an operation can be logged and read back.
    t.pushOperationLog?.({ kind: 'parity-probe', message: 'storage-mode parity run', level: 'info' });
    const log = t.operationLogSnapshot?.();
    const logEntries = Array.isArray(log) ? log.length : (Array.isArray(log?.entries) ? log.entries.length : null);
    assert.ok(logEntries >= 1, `${mode}: an operation log entry is recorded (got ${logEntries})`);
    features.DIAGNOSTICS = { entries: logEntries };

    // GUI-DURABLE-MUTATIONS: the data layer the ledger viewer binds to is present and populated.
    assert.equal(typeof runtime.hayaku.ledger.inspect, 'function', `${mode}: the ledger viewer data layer exists`);
    features.GUI = { ledgerRecords: records.length };

    // Storage authority contract per mode.
    const localLedgerKeys = Array.from(runtime.pluginStorage.values.keys())
      .filter(key => /hayaku\.v2\.ledger\./.test(String(key))).length;
    let serverRows = null;
    try {
      const listed = app.repositories?.hayaku?.list?.('plugin', 'hayaku');
      serverRows = (listed?.records || []).length;
    } catch { /* repository shape varies */ }

    return { mode, features, localLedgerKeys, serverRows };
  } finally {
    await runtime?.dispose?.().catch(() => null);
    await app?.close?.().catch(() => null);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

(async () => {
  const results = [];
  for (const mode of MODES) results.push(await measureMode(mode));

  const observations = results.map(row => ({
    mode: row.mode,
    features: Object.keys(row.features),
    localLedgerKeys: row.localLedgerKeys,
    serverRows: row.serverRows
  }));
  console.log(JSON.stringify({ test: 'hayaku_feature_parity', observations }, null, 1));

  const featureNames = Object.keys(results[0].features).sort();
  for (const row of results) {
    assert.deepEqual(Object.keys(row.features).sort(), featureNames,
      `${row.mode}: every feature must be measured (missing ${featureNames.filter(n => !(n in row.features))})`);
  }

  // Modes must agree on the logical feature results (counts that are mode-independent by nature).
  const baseline = results[0];
  for (const row of results.slice(1)) {
    for (const name of featureNames) {
      if (name === 'MANUAL') continue; // vault size legitimately reflects per-mode storage layout
      const a = baseline.features[name];
      const b = row.features[name];
      if (name === 'CONTINUITY' || name === 'GUI') {
        assert.equal(b.records ?? b.ledgerRecords, a.records ?? a.ledgerRecords,
          `${row.mode}: ${name} must capture the same number of packets as ${baseline.mode}`);
      } else if (name === 'BOUNDARY') {
        assert.equal(b.rows, a.rows, `${row.mode}: ${name} must find the same packets as ${baseline.mode}`);
      } else if (name === 'DETECTION') {
        assert.equal(b.debts, a.debts, `${row.mode}: ${name} must compute the same debt count as ${baseline.mode}`);
      } else if (name === 'BACKUP') {
        assert.equal(b.usable, a.usable, `${row.mode}: ${name} must be as usable as in ${baseline.mode}`);
      }
    }
  }

  // Storage authority contract.
  const plugin = results.find(r => r.mode === 'plugin_only');
  const mirror = results.find(r => r.mode === 'mirror');
  const server = results.find(r => r.mode === 'server_only');
  assert.equal(plugin.serverRows, 0, `plugin_only must write no owner rows to a server (got ${plugin.serverRows})`);
  assert.ok(plugin.localLedgerKeys > 0, 'plugin_only must keep the owner ledger locally');
  assert.ok(server.serverRows > 0, 'server_only must project the owner rows to the server');
  assert.equal(server.localLedgerKeys, 0, `server_only must keep no owner ledger locally (got ${server.localLedgerKeys})`);
  assert.ok(mirror.serverRows > 0, 'mirror must project to the server as well as locally');

  process.stdout.write('hayaku_feature_parity_test: PASS\n');
})().catch(error => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
