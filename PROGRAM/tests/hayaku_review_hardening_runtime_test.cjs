'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createHayakuRuntime, waitFor } = require('./fixtures/hayaku_runtime_harness.cjs');

const canonicalize = value => {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

const integrityFor = value => {
  const digest = crypto.createHash('sha256').update(canonicalize(value)).digest('hex');
  return { algorithm: 'SHA-256', digest, fallbackDigest: digest };
};

const signEnvelope = envelope => {
  const unsigned = JSON.parse(JSON.stringify(envelope));
  delete unsigned.integrity;
  return { ...unsigned, integrity: integrityFor(unsigned) };
};

(async () => {
  const runtime = await createHayakuRuntime({ autoRepair: false });
  try {
    const portable = await waitFor(
      () => runtime.context.__HAYAKUPortableMemoryBackup,
      'HAYAKU portable backup API'
    );
    const scope = await runtime.hayaku._test.currentChatScope();
    const ledgerKey = `hayaku.v2.ledger.${scope.key}`;
    const reservedTagObject = {
      ...runtime.hayaku._test.normalizeStorageLedger(null, scope),
      __portableType: 'Date',
      value: 'ordinary-data',
      other: 'must-survive'
    };
    await runtime.pluginStorage.setItem(ledgerKey, reservedTagObject);

    const envelope = await portable.exportCurrentScope();
    assert.equal(envelope.formatVersion, 3, 'scope-owned portable imports use format v3');
    const ledgerRecord = envelope.records.find(record => record.key === ledgerKey);
    assert.ok(ledgerRecord, 'current-scope ledger is exported');
    assert.equal(ledgerRecord.value.__portableType, 'PlainObject', 'ordinary objects use an unambiguous outer envelope');
    assert.equal(ledgerRecord.value.value.__portableType, 'Date', 'reserved user key remains ordinary payload data');
    assert.equal(ledgerRecord.ownership.kind, 'scope-owned');
    assert.equal(envelope.transcript.schema, 'hayaku.portable.transcript_identity.v1');

    await runtime.pluginStorage.setItem(ledgerKey, { replaced: true });
    const restored = await portable.restoreCurrentScope(envelope);
    assert.equal(restored.ok, true);
    assert.deepEqual(
      JSON.parse(JSON.stringify(await runtime.pluginStorage.getItem(ledgerKey))),
      JSON.parse(JSON.stringify(reservedTagObject)),
      'reserved-tag object round-trips without field loss'
    );

    const foreign = JSON.parse(JSON.stringify(envelope));
    foreign.source.scopeKey = 'chat_foreign_scope';
    foreign.source.scopeId = 'chat_foreign_scope';
    foreign.source.canonicalScopeId = '';
    foreign.source.chatId = '';
    foreign.source.canonicalChatId = '';
    foreign.source.aliases = [foreign.source.characterId, 'chat_foreign_scope'].filter(Boolean);
    await assert.rejects(
      portable.restoreCurrentScope(signEnvelope(foreign)),
      /portable_backup_(?:record_)?scope_mismatch/,
      'character-only identity cannot authorize a destructive restore'
    );

    const forgedOwnership = JSON.parse(JSON.stringify(envelope));
    const forgedLedger = forgedOwnership.records.find(record => record.key === ledgerKey);
    forgedLedger.key = 'hayaku.v2.ledger.chat_foreign_resigned_record';
    forgedLedger.integrity = integrityFor({
      key: forgedLedger.key,
      value: forgedLedger.value,
      mode: forgedLedger.mode,
      ownership: forgedLedger.ownership
    });
    await assert.rejects(
      portable.validateBackup(signEnvelope(forgedOwnership)),
      /portable_backup_record_ownership_unproven/,
      'a recomputed digest cannot turn a foreign scope-bound key into a source-owned record'
    );

    const substringOwnership = JSON.parse(JSON.stringify(envelope));
    const substringLedger = substringOwnership.records.find(record => record.key === ledgerKey);
    substringLedger.key = `hayaku.custom.prefix${scope.key}suffix`;
    substringLedger.integrity = integrityFor({
      key: substringLedger.key,
      value: substringLedger.value,
      mode: substringLedger.mode,
      ownership: substringLedger.ownership
    });
    await assert.rejects(
      portable.validateBackup(signEnvelope(substringOwnership)),
      /portable_backup_record_ownership_unproven/,
      'a scope id embedded inside a larger key token is not exact key-identity evidence'
    );

    const foreignSharedLedger = JSON.parse(JSON.stringify(envelope));
    const foreignSharedRoot = foreignSharedLedger.records.find(record => record.key === ledgerKey);
    const foreignSharedKey = 'hayaku.v2.ledger.chat_foreign_shared_dependency';
    foreignSharedRoot.value.value.dependencyKey = foreignSharedKey;
    foreignSharedRoot.integrity = integrityFor({
      key: foreignSharedRoot.key,
      value: foreignSharedRoot.value,
      mode: foreignSharedRoot.mode,
      ownership: foreignSharedRoot.ownership
    });
    const foreignSharedRecord = JSON.parse(JSON.stringify(foreignSharedRoot));
    foreignSharedRecord.key = foreignSharedKey;
    foreignSharedRecord.value.value.scopeKey = 'chat_foreign_shared_dependency';
    foreignSharedRecord.ownership = {
      kind: 'shared-dependency',
      scopeKey: scope.key,
      evidence: 'forged_explicit_reference'
    };
    foreignSharedRecord.integrity = integrityFor({
      key: foreignSharedRecord.key,
      value: foreignSharedRecord.value,
      mode: foreignSharedRecord.mode,
      ownership: foreignSharedRecord.ownership
    });
    foreignSharedLedger.records.push(foreignSharedRecord);
    foreignSharedLedger.inventory.dependencyKeys.push(foreignSharedKey);
    foreignSharedLedger.inventory.recordCount = foreignSharedLedger.records.length;
    foreignSharedLedger.inventory.sharedDependencyRecords = Number(foreignSharedLedger.inventory.sharedDependencyRecords || 0) + 1;
    await assert.rejects(
      portable.validateBackup(signEnvelope(foreignSharedLedger)),
      /portable_backup_shared_dependency_scope_bound/,
      'an explicit reference cannot relabel another chat ledger as a shared dependency'
    );

    const changedScopeRepresentation = JSON.parse(JSON.stringify(envelope));
    const legacyScopeKey = 'chat_legacy_scope_representation';
    changedScopeRepresentation.source.scopeKey = legacyScopeKey;
    changedScopeRepresentation.source.scopeId = legacyScopeKey;
    changedScopeRepresentation.source.canonicalScopeId = '';
    changedScopeRepresentation.transcript.scopeKey = legacyScopeKey;
    const legacyScopeLedger = changedScopeRepresentation.records.find(record => record.key === ledgerKey);
    legacyScopeLedger.key = `hayaku.v2.ledger.${legacyScopeKey}`;
    legacyScopeLedger.value.value.scopeKey = legacyScopeKey;
    legacyScopeLedger.ownership.scopeKey = legacyScopeKey;
    legacyScopeLedger.integrity = integrityFor({
      key: legacyScopeLedger.key,
      value: legacyScopeLedger.value,
      mode: legacyScopeLedger.mode,
      ownership: legacyScopeLedger.ownership
    });
    await assert.rejects(
      portable.analyzeImport(signEnvelope(changedScopeRepresentation), 'same_chat_replace'),
      /portable_backup_scope_representation_mismatch/,
      'same-chat replacement cannot write source-scope keys under a different current scope representation'
    );

    const legacyPlainObject = {
      schema: 'legacy-test-ledger',
      scopeKey: scope.key,
      __portableType: 'PlainObject',
      value: { ordinary: true },
      other: 'legacy-must-survive'
    };
    const legacyRecord = {
      ...ledgerRecord,
      value: legacyPlainObject,
      integrity: integrityFor({ key: ledgerKey, value: legacyPlainObject })
    };
    const legacyEnvelope = signEnvelope({
      ...envelope,
      formatVersion: 1,
      plugin: { ...envelope.plugin, version: '3.0.5' },
      records: [legacyRecord],
      inventory: {
        ...envelope.inventory,
        recordCount: 1,
        dependencyKeys: []
      }
    });
    await runtime.pluginStorage.setItem(ledgerKey, { replaced: 'before-legacy-restore' });
    const legacyRestored = await portable.restoreCurrentScope(legacyEnvelope);
    assert.equal(legacyRestored.ok, true);
    assert.deepEqual(
      JSON.parse(JSON.stringify(await runtime.pluginStorage.getItem(ledgerKey))),
      legacyPlainObject,
      'format-v1 PlainObject user data remains ordinary data'
    );
  } finally {
    await runtime.dispose();
  }

  const sourcePath = path.resolve(__dirname, '..', 'plugins', 'HAYAKU_Locator_Continuity.js');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const choiceStart = source.indexOf('const viewerResolveNativeRegenerationChoice = async decision =>');
  const resolverCall = source.indexOf('result = await resolveNativeRegenerationChoice', choiceStart);
  const choiceEnd = source.indexOf('const viewerRecordSort =', choiceStart);
  assert.ok(choiceStart >= 0 && resolverCall > choiceStart && choiceEnd > resolverCall);
  assert.doesNotMatch(
    source.slice(choiceStart, resolverCall),
    /updateNativeJob\([^)]*state:\s*decision === 'adopt_regenerated'/,
    'UI must not enter adopting before the durable resolver accepts the decision'
  );
  const resolverCatch = source.indexOf('} catch (error) {', resolverCall);
  const outcomeMessage = source.indexOf('const outcomeMessage =', resolverCatch);
  const viewerRefresh = source.indexOf('await refreshLedgerViewer();', outcomeMessage);
  assert.ok(resolverCatch > resolverCall && outcomeMessage > resolverCatch && viewerRefresh > outcomeMessage,
    'durable resolver errors and secondary viewer refresh errors use separate control flow');
  assert.match(source.slice(resolverCall, outcomeMessage), /finishNativeJob\('failed'/);
  assert.match(source.slice(outcomeMessage, choiceEnd), /viewerRefreshOk:\s*false/);

  const closeStart = source.indexOf('const closeLedgerViewer = async () =>');
  const closeEnd = source.indexOf('const bindLedgerViewerUi =', closeStart);
  assert.ok(closeStart >= 0 && closeEnd > closeStart);
  assert.match(source.slice(closeStart, closeEnd), /clearInterval\(Memory\.ledgerViewer\.jobTicker\)/,
    'closing the viewer stops hidden progress updates');

  const unloadStart = source.indexOf('await RisuCompat.onUnload(async () =>');
  const unloadEnd = source.indexOf('});', unloadStart);
  assert.ok(unloadStart >= 0 && unloadEnd > unloadStart);
  assert.match(source.slice(unloadStart, unloadEnd), /clearInterval\(Memory\.ledgerViewer\.jobTicker\)/);

  console.log('PASS hayaku_review_hardening_runtime_test');
})().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
