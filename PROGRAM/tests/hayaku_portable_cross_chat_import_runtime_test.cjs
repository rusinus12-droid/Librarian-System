'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  createStore,
  createValidPacket,
  hiddenPacketMessage,
  createHayakuRuntime,
  waitFor
} = require('./fixtures/hayaku_runtime_harness.cjs');

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

const sourceMessages = () => [
  { role: 'user', data: 'I enter the archive.', chatId: 'source-u1' },
  {
    role: 'assistant',
    data: hiddenPacketMessage(
      'Alice entered the archive.',
      createValidPacket({ turn: 1, summary: 'Alice entered the archive.' })
    ),
    chatId: 'source-a1'
  }
];

const copiedMessages = () => sourceMessages().map((message, index) => ({
  ...message,
  chatId: `${message.role === 'user' ? 'copy-u' : 'copy-a'}${index + 1}`
}));

const portableValidateInFreshRuntime = async envelope => {
  const runtime = await createHayakuRuntime({
    autoRepair: false,
    chatId: 'portable-migration-target',
    characterId: 'portable-character',
    messages: []
  });
  try {
    const portable = await waitFor(() => runtime.context.__HAYAKUPortableMemoryBackup,
      'portable validation API');
    return await portable.validateBackup(signEnvelope(envelope));
  } finally {
    await runtime.dispose();
  }
};

const createSourceEnvelope = async (pluginStorage = createStore()) => {
  const runtime = await createHayakuRuntime({
    autoRepair: false,
    chatId: 'portable-source-chat',
    characterId: 'portable-character',
    messages: sourceMessages(),
    pluginStorage
  });
  try {
    const scope = await runtime.hayaku._test.currentChatScope();
    const snapshot = runtime.hayaku._test.authoritativeChatSnapshot(scope.chatMessages, scope);
    const reconciled = await runtime.hayaku._test.reconcileObservedChatTopology(scope, snapshot, 'portable_import_fixture');
    assert.equal(reconciled.durable, true);
    const foreignKey = 'hayaku.v2.ledger.chat_foreign_portable_fixture';
    await runtime.pluginStorage.setItem(foreignKey, {
      schema: 'hayaku.storage.ledger.v2',
      scopeKey: 'chat_foreign_portable_fixture',
      marker: 'must-never-export'
    });
    const portable = await waitFor(() => runtime.context.__HAYAKUPortableMemoryBackup, 'portable API');
    const envelope = await portable.exportCurrentScope();
    assert.equal(portable.pluginVersion, runtime.hayaku.version);
    assert.equal(envelope.plugin.version, runtime.hayaku.version);
    assert.equal(envelope.formatVersion, 3);
    assert.equal(envelope.records.some(record => record.key === foreignKey), false,
      'foreign chat records never enter the current-chat backup');
    assert.ok(envelope.records.every(record => ['scope-owned', 'shared-dependency'].includes(record.ownership?.kind)));
    return { envelope, scopeKey: scope.key, pluginStorage };
  } finally {
    await runtime.dispose();
  }
};

(async () => {
  const { envelope, scopeKey, pluginStorage: sharedStore } = await createSourceEnvelope();

  const forgedTranscript = JSON.parse(JSON.stringify(envelope));
  forgedTranscript.transcript.pairs[0].assistantVisibleHash = 'forged-target-visible-hash';
  await assert.rejects(
    portableValidateInFreshRuntime(forgedTranscript),
    /portable_backup_transcript_ledger_binding_invalid/,
    'a re-signed transcript manifest cannot detach active source packets from their original U+A hashes'
  );

  const same = await createHayakuRuntime({
    autoRepair: false,
    chatId: 'portable-source-chat',
    characterId: 'portable-character',
    messages: sourceMessages()
  });
  try {
    const portable = await waitFor(() => same.context.__HAYAKUPortableMemoryBackup, 'same-chat portable API');
    const foreignKey = 'hayaku.v2.ledger.chat_foreign_survivor';
    await same.pluginStorage.setItem(foreignKey, { scopeKey: 'chat_foreign_survivor', marker: 'survive' });
    const result = await portable.restoreCurrentScope(envelope);
    assert.equal(result.ok, true);
    assert.deepEqual(
      JSON.parse(JSON.stringify(await same.pluginStorage.getItem(foreignKey))),
      { scopeKey: 'chat_foreign_survivor', marker: 'survive' },
      'same-chat replacement cannot delete a foreign chat key'
    );

    const sameScope = await same.hayaku._test.currentChatScope();
    const pendingKey = `hayaku.v2.recovery_vault.${sameScope.key}`;
    const analysis = await portable.analyzeImport(envelope, 'same_chat_replace');
    await same.pluginStorage.setItem(pendingKey, { scopeKey: sameScope.key, marker: 'created-after-confirmation' });
    await assert.rejects(
      portable.importBackup(envelope, {
        mode: 'same_chat_replace',
        expectedTargetFingerprint: analysis.targetFingerprint
      }),
      error => error?.code === 'PORTABLE_IMPORT_TARGET_CHANGED',
      'a target mutation after confirmation aborts before destructive replacement'
    );
    assert.equal((await same.pluginStorage.getItem(pendingKey))?.marker, 'created-after-confirmation');
    await same.pluginStorage.removeItem(pendingKey);

    const transcriptAnalysis = await portable.analyzeImport(envelope, 'same_chat_replace');
    same.setMessages([
      ...sourceMessages(),
      { role: 'user', data: 'A newly committed turn.', chatId: 'late-u2' },
      { role: 'assistant', data: 'The archive door closes.', chatId: 'late-a2' }
    ]);
    await assert.rejects(
      portable.importBackup(envelope, {
        mode: 'same_chat_replace',
        expectedTargetFingerprint: transcriptAnalysis.targetFingerprint
      }),
      error => error?.code === 'PORTABLE_IMPORT_TARGET_CHANGED',
      'a transcript mutation after confirmation aborts before storage replacement'
    );
    same.setMessages(sourceMessages());

    const originalSet = same.pluginStorage.setItem.bind(same.pluginStorage);
    let activeWrites = 0;
    let maxConcurrentWrites = 0;
    same.pluginStorage.setItem = async (key, value) => {
      activeWrites += 1;
      maxConcurrentWrites = Math.max(maxConcurrentWrites, activeWrites);
      try {
        await new Promise(resolve => setTimeout(resolve, 8));
        return await originalSet(key, value);
      } finally {
        activeWrites -= 1;
      }
    };
    await Promise.all([
      portable.restoreCurrentScope(envelope),
      portable.restoreCurrentScope(envelope)
    ]);
    assert.equal(maxConcurrentWrites, 1,
      'complete same-chat restore transactions are serialized through the HAYAKU storage queue');

    const originalGet = same.pluginStorage.getItem.bind(same.pluginStorage);
    let exportReadsDuringWrite = 0;
    same.pluginStorage.getItem = async key => {
      if (activeWrites > 0) exportReadsDuringWrite += 1;
      return await originalGet(key);
    };
    const [, serializedExport] = await Promise.all([
      portable.restoreCurrentScope(envelope),
      portable.exportCurrentScope()
    ]);
    assert.equal(serializedExport.schema, 'memory-suite.portable-memory-backup.v1');
    assert.equal(exportReadsDuringWrite, 0,
      'portable export inventory and record reads wait for an active restore transaction');
  } finally {
    await same.dispose();
  }

  const emptyEnumerationStore = createStore();
  emptyEnumerationStore.keys = async () => [];
  const emptyEnumerationRuntime = await createHayakuRuntime({
    autoRepair: false,
    chatId: 'portable-source-chat',
    characterId: 'portable-character',
    messages: sourceMessages(),
    pluginStorage: emptyEnumerationStore
  });
  try {
    const portable = await waitFor(() => emptyEnumerationRuntime.context.__HAYAKUPortableMemoryBackup,
      'empty enumeration portable API');
    const result = await portable.restoreCurrentScope(envelope);
    assert.equal(result.ok, true,
      'an available key enumerator returning an empty list is a valid empty target, not an unavailable API');
  } finally {
    await emptyEnumerationRuntime.dispose();
  }

  const rejectingStore = createStore();
  const rejectingRuntime = await createHayakuRuntime({
    autoRepair: false,
    chatId: 'portable-source-chat',
    characterId: 'portable-character',
    messages: sourceMessages(),
    pluginStorage: rejectingStore
  });
  try {
    const portable = await waitFor(() => rejectingRuntime.context.__HAYAKUPortableMemoryBackup,
      'rejecting storage portable API');
    const targetScope = await rejectingRuntime.hayaku._test.currentChatScope();
    const rejectedKey = `hayaku.v2.ledger.${targetScope.key}`;
    const originalSet = rejectingStore.setItem.bind(rejectingStore);
    let rejectedAttempts = 0;
    rejectingStore.setItem = async (key, value) => {
      if (key === rejectedKey) {
        rejectedAttempts += 1;
        return false;
      }
      return await originalSet(key, value);
    };
    await assert.rejects(
      portable.restoreCurrentScope(envelope),
      /portable_backup_write_rejected/,
      'a routed write rejection fails closed'
    );
    assert.equal(rejectedAttempts, 1,
      'a routed write rejection is not retried through compatibility and raw-storage bypasses');
  } finally {
    await rejectingRuntime.dispose();
  }

  const midTransactionStore = createStore();
  const midTransactionRuntime = await createHayakuRuntime({
    autoRepair: false,
    chatId: 'portable-source-chat',
    characterId: 'portable-character',
    messages: sourceMessages(),
    pluginStorage: midTransactionStore
  });
  try {
    const portable = await waitFor(() => midTransactionRuntime.context.__HAYAKUPortableMemoryBackup,
      'mid-transaction portable API');
    const targetScope = await midTransactionRuntime.hayaku._test.currentChatScope();
    const targetLedgerKey = `hayaku.v2.ledger.${targetScope.key}`;
    const originalSet = midTransactionStore.setItem.bind(midTransactionStore);
    let transcriptMutated = false;
    midTransactionStore.setItem = async (key, value) => {
      const result = await originalSet(key, value);
      if (!transcriptMutated && key === targetLedgerKey) {
        transcriptMutated = true;
        midTransactionRuntime.setMessages([
          ...sourceMessages(),
          { role: 'user', data: 'Committed during restore.', chatId: 'during-u2' },
          { role: 'assistant', data: 'The state changed.', chatId: 'during-a2' }
        ]);
      }
      return result;
    };
    await assert.rejects(
      portable.restoreCurrentScope(envelope),
      /portable_import_target_transcript_changed_during_transaction/,
      'a transcript change during physical writes triggers rollback before success'
    );
    assert.equal(await midTransactionRuntime.pluginStorage.getItem(targetLedgerKey), null,
      'mid-transaction transcript drift restores the absent target ledger');
  } finally {
    await midTransactionRuntime.dispose();
  }

  const incompleteRollbackStore = createStore();
  const incompleteRollbackRuntime = await createHayakuRuntime({
    autoRepair: false,
    chatId: 'portable-source-chat',
    characterId: 'portable-character',
    messages: sourceMessages(),
    pluginStorage: incompleteRollbackStore
  });
  try {
    const portable = await waitFor(() => incompleteRollbackRuntime.context.__HAYAKUPortableMemoryBackup,
      'incomplete rollback portable API');
    const targetScope = await incompleteRollbackRuntime.hayaku._test.currentChatScope();
    const targetLedgerKey = `hayaku.v2.ledger.${targetScope.key}`;
    const originalSet = incompleteRollbackStore.setItem.bind(incompleteRollbackStore);
    incompleteRollbackStore.setItem = async (key, value) => {
      const result = await originalSet(key, value);
      if (key === targetLedgerKey) {
        incompleteRollbackRuntime.setMessages([
          ...sourceMessages(),
          { role: 'user', data: 'Rollback removal must be verified.', chatId: 'rollback-u2' },
          { role: 'assistant', data: 'The target changed.', chatId: 'rollback-a2' }
        ]);
      }
      return result;
    };
    incompleteRollbackStore.removeItem = async key => {
      if (key === targetLedgerKey) return true;
      incompleteRollbackStore.values.delete(key);
      return true;
    };
    await assert.rejects(
      portable.restoreCurrentScope(envelope),
      error => error?.code === 'PORTABLE_RESTORE_FAILED_ROLLBACK_INCOMPLETE'
        && /rollback_failures=1/.test(error.message),
      'a backend that reports removal success but leaves a newly written key is reported as incomplete rollback'
    );
    assert.notEqual(await incompleteRollbackStore.getItem(targetLedgerKey), null,
      'the fixture must leave the key behind so rollback readback detection is exercised');
  } finally {
    await incompleteRollbackRuntime.dispose();
  }

  let migratedEnvelope = null;
  const migrated = await createHayakuRuntime({
    autoRepair: false,
    chatId: 'portable-migration-target',
    characterId: 'portable-character',
    messages: [],
    pluginStorage: sharedStore
  });
  try {
    const portable = await waitFor(() => migrated.context.__HAYAKUPortableMemoryBackup, 'migration portable API');
    const analysis = await portable.analyzeImport(envelope, 'new_chat_migration');
    assert.equal(analysis.targetPairs, 0);
    assert.ok(analysis.archiveCandidates > 0);
    const result = await portable.importBackup(envelope, { mode: 'new_chat_migration' });
    assert.equal(result.ok, true);
    assert.equal(result.durable, true);
    const targetScope = await migrated.hayaku._test.currentChatScope();
    const ledgerKey = `hayaku.v2.ledger.${targetScope.key}`;
    const ledger = migrated.hayaku._test.normalizeStorageLedger(
      await migrated.pluginStorage.getItem(ledgerKey),
      targetScope
    );
    const hydrated = await migrated.hayaku._test.hydrateHayakuLedgerArchive(ledger);
    assert.equal(ledger.records.length, 0, 'migration does not impersonate live target turns');
    assert.equal(ledger.worldline.nodes.length, 0, 'migration starts with an empty target worldline');
    assert.equal(hydrated.archiveVerified, true);
    assert.ok(hydrated.archiveRecords > 0);
    assert.equal(ledger.portableImport?.mode, 'new_chat_migration');
    assert.equal(ledger.portableImport?.sourceScopeKey, scopeKey);
    migratedEnvelope = await portable.exportCurrentScope();
    assert.ok(migratedEnvelope.records.some(record => record.key.startsWith('hayaku.v2.shared_archive.')),
      'a migrated target export closes over its referenced shared archive body');
    assert.ok(migratedEnvelope.records.some(record => record.key.startsWith('hayaku.v2.shared_archive_meta.')),
      'a migrated target export closes over its referenced shared archive metadata');
    assert.equal(migratedEnvelope.records.some(record => record.key === `hayaku.v2.ledger.${scopeKey}`), false,
      'source provenance text is not treated as a storage-key reference');
  } finally {
    await migrated.dispose();
  }

  const restoredMigration = await createHayakuRuntime({
    autoRepair: false,
    chatId: 'portable-migration-target',
    characterId: 'portable-character',
    messages: []
  });
  try {
    const portable = await waitFor(() => restoredMigration.context.__HAYAKUPortableMemoryBackup,
      'migrated backup restore API');
    const result = await portable.restoreCurrentScope(migratedEnvelope);
    assert.equal(result.ok, true);
    const targetScope = await restoredMigration.hayaku._test.currentChatScope();
    const ledger = restoredMigration.hayaku._test.normalizeStorageLedger(
      await restoredMigration.pluginStorage.getItem(`hayaku.v2.ledger.${targetScope.key}`),
      targetScope
    );
    const hydrated = await restoredMigration.hayaku._test.hydrateHayakuLedgerArchive(ledger);
    assert.equal(hydrated.archiveVerified, true,
      'same-chat restore into a fresh store restores and verifies the referenced archive');
    assert.ok(hydrated.archiveRecords > 0);
  } finally {
    await restoredMigration.dispose();
  }

  const collisionStore = createStore();
  const sharedDependency = migratedEnvelope.records.find(record => (
    record.ownership?.kind === 'shared-dependency'
    && record.key.startsWith('hayaku.v2.shared_archive.')
  ));
  assert.ok(sharedDependency, 'migrated backup contains a shared archive dependency');
  await collisionStore.setItem(sharedDependency.key, JSON.stringify({ marker: 'foreign-immutable-body' }));
  const collisionRuntime = await createHayakuRuntime({
    autoRepair: false,
    chatId: 'portable-migration-target',
    characterId: 'portable-character',
    messages: [],
    pluginStorage: collisionStore
  });
  try {
    const portable = await waitFor(() => collisionRuntime.context.__HAYAKUPortableMemoryBackup,
      'shared dependency collision API');
    await assert.rejects(
      portable.restoreCurrentScope(migratedEnvelope),
      /portable_backup_shared_dependency_collision/,
      'same-key shared archive collisions fail closed instead of overwriting immutable data'
    );
    assert.equal(await collisionRuntime.pluginStorage.getItem(sharedDependency.key),
      JSON.stringify({ marker: 'foreign-immutable-body' }));
  } finally {
    await collisionRuntime.dispose();
  }

  const corruptedArchiveEnvelope = JSON.parse(JSON.stringify(migratedEnvelope));
  const corruptedArchiveRecord = corruptedArchiveEnvelope.records.find(record => (
    record.ownership?.kind === 'shared-dependency'
    && record.key.startsWith('hayaku.v2.shared_archive.')
  ));
  const corruptedArchiveBody = JSON.parse(corruptedArchiveRecord.value);
  corruptedArchiveBody.deltaCount = Number(corruptedArchiveBody.deltaCount || 0) + 1;
  corruptedArchiveRecord.value = JSON.stringify(corruptedArchiveBody);
  corruptedArchiveRecord.integrity = integrityFor({
    key: corruptedArchiveRecord.key,
    value: corruptedArchiveRecord.value,
    mode: corruptedArchiveRecord.mode,
    ownership: corruptedArchiveRecord.ownership
  });
  await assert.rejects(
    portableValidateInFreshRuntime(corruptedArchiveEnvelope),
    /portable_backup_archive_delta_count_mismatch/,
    'a re-signed but internally inconsistent archive body is rejected before restore'
  );

  const pollutedArchiveEnvelope = JSON.parse(JSON.stringify(migratedEnvelope));
  const pollutedArchiveRecord = pollutedArchiveEnvelope.records.find(record => (
    record.ownership?.kind === 'shared-dependency'
    && record.key.startsWith('hayaku.v2.shared_archive.')
  ));
  const pollutedArchiveBody = JSON.parse(pollutedArchiveRecord.value);
  pollutedArchiveBody.records.push({ raw: '{not-a-valid-packet}', marker: 'must-not-be-silently-filtered' });
  pollutedArchiveRecord.value = JSON.stringify(pollutedArchiveBody);
  pollutedArchiveRecord.integrity = integrityFor({
    key: pollutedArchiveRecord.key,
    value: pollutedArchiveRecord.value,
    mode: pollutedArchiveRecord.mode,
    ownership: pollutedArchiveRecord.ownership
  });
  await assert.rejects(
    portableValidateInFreshRuntime(pollutedArchiveEnvelope),
    /portable_backup_archive_record_invalid/,
    'a re-signed archive cannot hide malformed physical records behind normalization filtering'
  );

  const sourceAfterMigration = await createHayakuRuntime({
    autoRepair: false,
    chatId: 'portable-source-chat',
    characterId: 'portable-character',
    messages: sourceMessages(),
    pluginStorage: sharedStore
  });
  try {
    const portable = await waitFor(() => sourceAfterMigration.context.__HAYAKUPortableMemoryBackup,
      'source re-export portable API');
    const targetScope = await sourceAfterMigration.hayaku._test.currentChatScope();
    assert.equal(targetScope.key, scopeKey);
    const reexported = await portable.exportCurrentScope();
    const migrationTargetKey = [...sharedStore.values.keys()].find(key => (
      key.startsWith('hayaku.v2.ledger.')
      && key !== `hayaku.v2.ledger.${scopeKey}`
      && JSON.stringify(sharedStore.values.get(key)).includes('new_chat_migration')
    ));
    assert.ok(migrationTargetKey, 'migration target ledger exists in the shared plugin store');
    assert.equal(reexported.records.some(record => record.key === migrationTargetKey), false,
      'nested source provenance in a target ledger cannot make it source-chat-owned');
  } finally {
    await sourceAfterMigration.dispose();
  }

  const copied = await createHayakuRuntime({
    autoRepair: false,
    chatId: 'portable-copy-target',
    characterId: 'portable-character',
    messages: copiedMessages()
  });
  try {
    const portable = await waitFor(() => copied.context.__HAYAKUPortableMemoryBackup, 'copy portable API');
    const analysis = await portable.analyzeImport(envelope, 'copied_chat_recovery');
    assert.equal(analysis.matchedPairs, 1);
    assert.equal(analysis.ambiguousPairs.length, 0);
    const result = await portable.importBackup(envelope, { mode: 'copied_chat_recovery' });
    assert.equal(result.ok, true);
    assert.equal(result.matchedPairs, 1);
    const targetScope = await copied.hayaku._test.currentChatScope();
    const ledgerKey = `hayaku.v2.ledger.${targetScope.key}`;
    const ledger = copied.hayaku._test.normalizeStorageLedger(
      await copied.pluginStorage.getItem(ledgerKey),
      targetScope
    );
    const imported = ledger.records.filter(record => record.captureSource === 'portable_chat_copy_recovery');
    assert.equal(imported.length, 1);
    assert.equal(imported[0].recordState, 'active');
    assert.ok(imported[0].ownerTurnNodeId);
    assert.equal(ledger.worldline.nodes.length, 1);
    assert.equal(ledger.portableImport?.mode, 'copied_chat_recovery');
    assert.equal(ledger.portableImport?.verified, true);
  } finally {
    await copied.dispose();
  }

  const mismatch = await createHayakuRuntime({
    autoRepair: false,
    chatId: 'portable-copy-mismatch',
    characterId: 'portable-character',
    messages: [
      { role: 'user', data: 'I enter the archive.', chatId: 'mismatch-u1' },
      { role: 'assistant', data: 'A different event happened.', chatId: 'mismatch-a1' }
    ]
  });
  try {
    const portable = await waitFor(() => mismatch.context.__HAYAKUPortableMemoryBackup, 'mismatch portable API');
    await assert.rejects(
      portable.analyzeImport(envelope, 'copied_chat_recovery'),
      /portable_copy_no_verified_matches/
    );
  } finally {
    await mismatch.dispose();
  }

  const auxiliaryTarget = await createHayakuRuntime({
    autoRepair: false,
    chatId: 'portable-auxiliary-target',
    characterId: 'portable-character',
    messages: []
  });
  try {
    const portable = await waitFor(() => auxiliaryTarget.context.__HAYAKUPortableMemoryBackup,
      'auxiliary target portable API');
    const targetScope = await auxiliaryTarget.hayaku._test.currentChatScope();
    await auxiliaryTarget.pluginStorage.setItem(
      `hayaku.v2.recovery_vault.${targetScope.key}`,
      auxiliaryTarget.hayaku._test.emptyRecoveryVault(targetScope)
    );
    await assert.rejects(
      portable.analyzeImport(envelope, 'new_chat_migration'),
      /portable_migration_target_not_empty/,
      'a target Recovery Vault makes migration non-empty even when its ledger and transcript are empty'
    );
  } finally {
    await auxiliaryTarget.dispose();
  }

  const rollbackStore = createStore();
  const originalSet = rollbackStore.setItem.bind(rollbackStore);
  const unrelatedArchiveKey = 'hayaku.v2.shared_archive.unrelated_rollback_fixture';
  const unrelatedArchiveValue = JSON.stringify({ marker: 'must-not-be-rewritten' });
  await originalSet(unrelatedArchiveKey, unrelatedArchiveValue);
  let failProof = false;
  let unrelatedWrites = 0;
  rollbackStore.setItem = async (key, value) => {
    if (key === unrelatedArchiveKey) unrelatedWrites += 1;
    if (failProof
      && String(key).startsWith('hayaku.v2.ledger.')
      && String(value).includes('"portableImport"')
      && String(value).includes('"verified":true')) return false;
    return await originalSet(key, value);
  };
  const rollback = await createHayakuRuntime({
    autoRepair: false,
    chatId: 'portable-rollback-target',
    characterId: 'portable-character',
    messages: [],
    pluginStorage: rollbackStore
  });
  try {
    const portable = await waitFor(() => rollback.context.__HAYAKUPortableMemoryBackup, 'rollback portable API');
    failProof = true;
    await assert.rejects(
      portable.importBackup(envelope, { mode: 'new_chat_migration' }),
      error => error?.code === 'PORTABLE_IMPORT_FAILED_ROLLED_BACK'
    );
    const targetScope = await rollback.hayaku._test.currentChatScope();
    assert.equal(await rollback.pluginStorage.getItem(`hayaku.v2.ledger.${targetScope.key}`), null,
      'failed import restores the target ledger to its absent pre-import state');
    assert.equal(await rollback.pluginStorage.getItem(unrelatedArchiveKey), unrelatedArchiveValue,
      'failed import preserves an unrelated shared archive');
    assert.equal(unrelatedWrites, 0,
      'rollback journals only keys touched by this import transaction');
    assert.deepEqual(
      [...rollbackStore.values.keys()].filter(key => (
        key.startsWith('hayaku.v2.shared_archive.')
        || key.startsWith('hayaku.v2.shared_archive_meta.')
      ) && key !== unrelatedArchiveKey),
      [],
      'failed import also removes newly created archive and archive-metadata records'
    );
  } finally {
    await rollback.dispose();
  }

  const foreignCharacter = await createHayakuRuntime({
    autoRepair: false,
    chatId: 'portable-foreign-character-target',
    characterId: 'different-character',
    messages: []
  });
  try {
    const portable = await waitFor(() => foreignCharacter.context.__HAYAKUPortableMemoryBackup, 'foreign character portable API');
    await assert.rejects(
      portable.analyzeImport(envelope, 'new_chat_migration'),
      /portable_cross_character_import_blocked/
    );
  } finally {
    await foreignCharacter.dispose();
  }

  const syntheticEnvelope = JSON.parse(JSON.stringify(envelope));
  syntheticEnvelope.source.characterId = 'charIndex:0';
  syntheticEnvelope.source.canonicalCharacterId = 'charIndex:0';
  syntheticEnvelope.source.aliases = syntheticEnvelope.source.aliases
    .filter(value => value !== 'portable-character')
    .concat('charIndex:0');
  syntheticEnvelope.transcript.characterId = 'charIndex:0';
  const syntheticCharacter = await createHayakuRuntime({
    autoRepair: false,
    chatId: 'portable-synthetic-character-target',
    characterId: 'charIndex:0',
    messages: []
  });
  try {
    const portable = await waitFor(() => syntheticCharacter.context.__HAYAKUPortableMemoryBackup,
      'synthetic character portable API');
    await assert.rejects(
      portable.analyzeImport(signEnvelope(syntheticEnvelope), 'new_chat_migration'),
      /portable_cross_character_import_blocked/,
      'a session-local charIndex fallback cannot prove cross-chat character identity'
    );
  } finally {
    await syntheticCharacter.dispose();
  }

  console.log('PASS hayaku_portable_cross_chat_import_runtime_test');
})().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
