'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const requestedPlugin = process.argv[2] || process.env.LIBRA_TEST_PLUGIN;
const source = fs.readFileSync(requestedPlugin ? path.resolve(requestedPlugin) : path.resolve(__dirname, '..', 'plugins', 'LIBRA.js'), 'utf8');
assert.match(source, /LibraMemoryCore\.state\.queues\.size > 0[\s\S]{0,100}LibraMemoryCore\.state\.receiptQueues\.size > 0[\s\S]{0,100}LibraMemoryCore\.state\.microQueues\.size > 0[\s\S]{0,200}LIBRA_WORLD_MANAGER_BUSY/,
  'portable acquire must reject canonical, durable receipt and background Micro scope transactions');
const values = new Map();
let rejectSet = null;
let rejectRemove = null;
const storage = {
  async getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null; },
  async setItem(key, value) {
    if (typeof rejectSet === 'function' && rejectSet(String(key), value)) return false;
    values.set(String(key), value);
    return true;
  },
  async removeItem(key) {
    if (typeof rejectRemove === 'function' && rejectRemove(String(key))) return false;
    values.delete(String(key)); return true;
  },
  async keys() { return Array.from(values.keys()); }
};

const transcript = idPrefix => {
  const messages = [];
  for (let turn = 1; turn <= 10; turn += 1) {
    messages.push({ role: 'user', data: `User establishes portable fact ${turn}.`, chatId: `${idPrefix}-u-${turn}` });
    messages.push({ role: 'assistant', data: `Assistant confirms portable fact ${turn}.`, chatId: `${idPrefix}-a-${turn}` });
  }
  return messages;
};
const chats = [
  { id: 'libra-portable-source', chatId: 'libra-portable-source', name: 'Source', message: transcript('source'), bindedPersona: '' },
  { id: 'libra-portable-migration', chatId: 'libra-portable-migration', name: 'Migration', message: [], bindedPersona: '' },
  { id: 'libra-portable-copy', chatId: 'libra-portable-copy', name: 'Copy', message: transcript('copy'), bindedPersona: '' },
  { id: 'libra-portable-diverged', chatId: 'libra-portable-diverged', name: 'Diverged', message: transcript('diverged'), bindedPersona: '' },
  { id: 'libra-portable-empty-source-target', chatId: 'libra-portable-empty-source-target', name: 'Empty source target', message: [], bindedPersona: '' }
];
chats[3].message[11].data = 'A conflicting sixth assistant turn changes the worldline.';
for (const chat of chats) chat.messages = chat.message;
const character = { id: 'libra-portable-character', chaId: 'libra-portable-character', name: 'Portable Character', chatPage: 0, chats };
let currentChatIndex = 0;
// A real RisuAI host keeps the character's chatPage equal to the selected chat;
// the unified recall's readonly source context reads the selection from it.
const selectChat = index => { currentChatIndex = index; character.chatPage = index; };
const unloadHandlers = [];
const host = {
  pluginStorage: storage,
  safeLocalStorage: storage,
  async getLocalPluginStorage() { return storage; },
  async getArgument(name) {
    const key = String(name || '');
    if (key.includes('memory_suite_server_mode')) return 'plugin_only';
    if (key.includes('enable_gui')) return 'false';
    if (key.includes('embedding_provider')) return 'hash';
    return '';
  },
  async getArg(name) { return this.getArgument(name); },
  async setArgument() { return true; },
  async nativeFetch() { throw new Error('portable restore runtime test has no provider or server'); },
  async onUnload(handler) { unloadHandlers.push(handler); return true; },
  async registerSetting() { return true; }, async unregisterSetting() { return true; },
  async registerButton() { return true; }, async unregisterButton() { return true; },
  async registerUIPart() { return true; }, async unregisterUIPart() { return true; },
  async addRisuReplacer() { return true; }, async removeRisuReplacer() { return true; },
  async addRisuChatListener() { return true; }, async removeRisuChatListener() { return true; },
  async addRisuScriptHandler() { return true; }, async removeRisuScriptHandler() { return true; },
  async addPluginChannelListener() { return true; }, async removePluginChannelListener() { return true; },
  async postPluginChannelMessage() { return true; },
  async getDatabase(fields) {
    const all = { personas: [], selectedPersona: '', characters: [character], plugins: [] };
    return Array.isArray(fields) ? Object.fromEntries(fields.map(field => [field, all[field] ?? null])) : all;
  },
  async setDatabase() { return true; },
  async getCurrentCharacterIndex() { return 0; }, async getCurrentChatIndex() { return currentChatIndex; },
  async getCharacter() { return character; }, async getCharacterFromIndex() { return character; },
  async getChat() { return chats[currentChatIndex]; }, async getCurrentChat() { return chats[currentChatIndex]; },
  async getChatFromIndex(_characterIndex, chatIndex) { return chats[Number(chatIndex ?? currentChatIndex)] || chats[currentChatIndex]; },
  async showContainer() { return true; }, async hideContainer() { return true; },
  async getRootContainer() { return null; }, async getPluginRoot() { return null; }
};

const activeTimeouts = new Set();
const activeIntervals = new Set();
const trackedSetTimeout = (handler, delay, ...args) => {
  let timer;
  timer = setTimeout((...inner) => { activeTimeouts.delete(timer); handler(...inner); }, delay, ...args);
  activeTimeouts.add(timer);
  return timer;
};
const trackedClearTimeout = timer => { activeTimeouts.delete(timer); clearTimeout(timer); };
const trackedSetInterval = (handler, delay, ...args) => { const timer = setInterval(handler, delay, ...args); activeIntervals.add(timer); return timer; };
const trackedClearInterval = timer => { activeIntervals.delete(timer); clearInterval(timer); };
const context = vm.createContext({
  risuai: host,
  console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
  setTimeout: trackedSetTimeout, clearTimeout: trackedClearTimeout,
  setInterval: trackedSetInterval, clearInterval: trackedClearInterval,
  queueMicrotask, AbortController, AbortSignal, DOMException,
  URL, URLSearchParams, TextEncoder, TextDecoder,
  crypto: globalThis.crypto, structuredClone: globalThis.structuredClone,
  performance: globalThis.performance, fetch: globalThis.fetch,
  Headers: globalThis.Headers, Request: globalThis.Request, Response: globalThis.Response,
  FormData: globalThis.FormData, Blob: globalThis.Blob,
  atob: globalThis.atob, btoa: globalThis.btoa,
  confirm: () => false, alert: () => {}, prompt: () => null
});

const waitFor = async (predicate, label, timeoutMs = 15000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
};
const parsed = key => {
  const value = values.get(key);
  return typeof value === 'string' ? JSON.parse(value) : structuredClone(value);
};
const canonicalize = value => {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};
const stateStoredValueDigest = value => {
  const body = canonicalize(value == null ? null : value);
  let hash = 2166136261;
  for (let index = 0; index < body.length; index += 1) {
    hash ^= body.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  hash ^= 31;
  hash = Math.imul(hash, 16777619);
  return `${(hash >>> 0).toString(16).padStart(8, '0')}:${body.length + 1}`;
};
const shaIntegrity = value => ({ algorithm: 'SHA-256', digest: crypto.createHash('sha256').update(canonicalize(value)).digest('hex') });
const resignEnvelope = envelope => {
  for (const record of envelope.records) record.integrity = shaIntegrity({ key: record.key, value: record.value });
  const unsigned = structuredClone(envelope);
  delete unsigned.integrity;
  envelope.integrity = shaIntegrity(unsigned);
  return envelope;
};
const scopeManifestEntry = chatId => Array.from(values.entries()).find(([key, raw]) => {
  if (!String(key).endsWith(':manifest')) return false;
  const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return value?.schema === 'libra.manifest.v1' && value?.chatId === chatId;
});

(async () => {
  vm.runInContext(source, context, { filename: 'LIBRA-portable-cross-chat-runtime.js' });
  const api = await waitFor(() => context.__LIBRA__, 'LIBRA API');
  const portable = await waitFor(() => context.__LIBRAPortableMemoryBackup, 'LIBRA portable API');
  assert.equal(api.version, source.match(/^[\/][\/]@version\s+(\S+)/m)[1]);
  const cold = await api.startManualColdStart();
  assert.equal(cold.total, 2);
  assert.equal(cold.failed, 2, 'provider-free fixture leaves two durable source runs to seed');
  const [manifestKey] = scopeManifestEntry('libra-portable-source');
  const manifest = parsed(manifestKey);
  const scopePrefix = manifestKey.slice(0, -':manifest'.length);
  const runs = Array.from(values.entries())
    .filter(([key]) => String(key).startsWith(`${scopePrefix}:run:`))
    .map(([, raw]) => typeof raw === 'string' ? JSON.parse(raw) : raw)
    .filter(run => [1, 6].includes(Number(run?.turnRange?.start || 0)));
  // New writer requires a verified previous Head and does not create a failed-run
  // placeholder for a later gap. Seed legacy test records from actual source inventory.
  const inventory=await api.listCanonicalBatchRanges();
  for(const range of inventory.ranges)if(!runs.some(r=>r.turnRange.start===range.startTurn)){
    const pairs=api.debugBuildPairs(chats[currentChatIndex]);
    runs.push({...structuredClone(runs[0]),runId:'legacy_fixture_'+range.startTurn,
      turnRange:{start:range.startTurn,end:range.endTurn},sourceDigest:range.sourceDigest,
      sourcePairs:pairs.slice(range.startTurn-1,range.endTurn).map(p=>({turn:p.turn,userChatId:p.user.chatId,assistantChatId:p.assistant.chatId}))});
  }
  assert.equal(runs.length, 2);
  for (const run of runs) {
    const startTurn = Number(run.turnRange.start);
    const memoryId = `portable_mem_${startTurn}`;
    const memoryKey = `${scopePrefix}:memory:${startTurn}:r1`;
    const now = new Date().toISOString();
    const memory = {
      schema: 'libra.canonical_memory.v1', memoryId, scopeKey: manifest.scopeKey,
      branchId: run.sourceDigest, turnRange: run.turnRange, sourcePairs: run.sourcePairs,
      sourceDigest: run.sourceDigest, revision: 1, status: 'committed',
      text: `Canonical portable memory ${startTurn}`, summary: `Portable ${startTurn}`,
      recallKeys: [], importance: 0.5, sections: {}, anchors: {},
      retrieval: { version: 'libra.retrieval_projection.v2' },
      embedding: { status: 'disabled', projectionVersion: 'libra.retrieval_projection.v2' },
      runId: run.runId, createdAt: now, updatedAt: now
    };
    if (startTurn === 1) {
      const profileId = 'portable-test-profile';
      const vectorKey = `${scopePrefix}:vector:${memoryId}:r1:${profileId}`;
      memory.embedding = { status: 'ready', vectorKey, profileId, vectorCount: 1, projectionVersion: 'libra.retrieval_projection.v2' };
      values.set(vectorKey, JSON.stringify({
        schema: 'libra.embedding_projection.v2', projectionVersion: 'libra.retrieval_projection.v2',
        scopeKey: manifest.scopeKey, memoryId, revision: 1, profileId, provider: 'fixture', model: 'fixture',
        dimensions: 2, configHash: 'fixture-config', requestHash: 'fixture-request', contextual: false,
        entries: { global: { key: 'global', section: 'global', vector: [1, 0], textHash: 'fixture-text' } },
        vector: [1, 0], textHash: 'fixture-text', vectorHash: 'fixture-vector', createdAt: now
      }));
    }
    values.set(memoryKey, JSON.stringify(memory));
    manifest.memories[String(startTurn)] = {
      memoryId, key: memoryKey, revision: 1, sourceDigest: run.sourceDigest,
      status: 'committed', turnRange: run.turnRange, summary: memory.summary,
      embeddingStatus: memory.embedding.status, sessionEpoch: 0, inheritedSessionHistory: false,
      createdAt: now, updatedAt: now, history: []
    };
  }
  const predecessorArchiveId = 'fixture_source_archive';
  const predecessorCanonicalId = 'fixture_predecessor_canonical';
  const predecessorMemoryId = 'arc_fixture_predecessor';
  const predecessorKey = `libra:v1:shared-archive:${predecessorArchiveId}:memory:${predecessorCanonicalId}:r1`;
  const predecessorMemory = {
    schema: 'libra.canonical_memory.v1', memoryId: predecessorMemoryId,
    scopeKey: `archive:${predecessorArchiveId}`, branchId: 'fixture-predecessor-digest',
    characterId: manifest.characterId, chatId: manifest.chatId,
    turnRange: { start: 1, end: 5 }, sourcePairs: [], sourceDigest: 'fixture-predecessor-digest',
    revision: 1, status: 'committed', text: 'Inherited portable predecessor', summary: 'Inherited predecessor',
    recallKeys: [], importance: 0.4, sections: {}, anchors: {}, retrieval: { version: 'libra.retrieval_projection.v2' },
    embedding: { status: 'disabled', projectionVersion: 'libra.retrieval_projection.v2' },
    archiveShared: true, archiveId: predecessorArchiveId, archiveCanonicalId: predecessorCanonicalId,
    sessionEpoch: -1, inheritedSessionHistory: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
  values.set(predecessorKey, JSON.stringify(predecessorMemory));
  manifest.inheritedMemories = [{
    memoryId: predecessorMemoryId, key: predecessorKey, revision: 1,
    sourceDigest: predecessorMemory.sourceDigest, status: 'committed', turnRange: predecessorMemory.turnRange,
    summary: predecessorMemory.summary, embeddingStatus: 'disabled', archiveShared: true,
    archiveId: predecessorArchiveId, archiveCanonicalId: predecessorCanonicalId,
    sessionEpoch: -1, inheritedSessionHistory: true, createdAt: predecessorMemory.createdAt, updatedAt: predecessorMemory.updatedAt
  }];
  manifest.inFlight = null;
  manifest.frontiers = { observedTurn: 10, committedTurn: 10 };
  values.set(manifestKey, JSON.stringify(manifest));

  const correctionJournalKey = `${scopePrefix}:state-corrections:v2`;
  const correctionMetaKey = `${scopePrefix}:state-correction-meta:v1`;
  const correctionCommitKey = `${scopePrefix}:state-correction-commit:v1`;
  const correctionJournal = {
    schema: 'libra.state_correction_store.v1', scopeKey: manifest.scopeKey, revision: 3,
    records: [{ schema: 'libra.state_correction.v1', scopeKey: manifest.scopeKey, correctionId: 'portable-correction', status: 'active' }],
    migratedLegacyOverrideIds: [], updatedAt: '2026-08-31T00:00:00.000Z'
  };
  const correctionJournalDigest = stateStoredValueDigest({
    schema: correctionJournal.schema, scopeKey: correctionJournal.scopeKey, revision: correctionJournal.revision,
    records: correctionJournal.records, migratedLegacyOverrideIds: correctionJournal.migratedLegacyOverrideIds
  });
  const correctionMeta = {
    schema: 'libra.state_correction_meta.v1', scopeKey: manifest.scopeKey,
    journalRevision: correctionJournal.revision, journalDigest: correctionJournalDigest,
    correctionCounts: { active: 1, suspended: 0, dormant_after_rollback: 0, superseded: 0, deleted: 0, total: 1, available: true },
    updatedAt: correctionJournal.updatedAt
  };
  const correctionCommit = {
    schema: 'libra.state_correction_commit.v1', scopeKey: manifest.scopeKey, status: 'committed', transactionId: 'portable-fixture',
    targetJournalRevision: correctionMeta.journalRevision, targetJournalDigest: correctionMeta.journalDigest,
    updatedAt: correctionJournal.updatedAt, committedAt: correctionJournal.updatedAt
  };
  values.set(correctionJournalKey, JSON.stringify(correctionJournal));
  values.set(correctionMetaKey, JSON.stringify(correctionMeta));
  values.set(correctionCommitKey, JSON.stringify(correctionCommit));

  const foreignKey = 'libra:v1:scope:foreign-scope:manifest';
  values.set(foreignKey, JSON.stringify({ schema: 'libra.manifest.v1', scopeKey: 'foreign-scope', marker: 'survive' }));
  await waitFor(() => { const state=api.getCaptureBackendState();
    return state.receiptQueueScopes===0 && state.microQueueScopes===0 && state.microQueuedJobs===0;
  }, 'admitted background owner work drains before portable export');
  for(const turn of [1,2,3]){
    const activeReceipt=await api.debugReadActiveCompletedTurnReceipt(turn);
    assert.equal(activeReceipt.status,'verified');
    const explicitMicro=await api.retryMicroAnalysis({scope:{scopeKey:manifest.scopeKey,scopeId:manifest.scopeKey,
      characterId:character.id,chatId:chats[currentChatIndex].id},receiptRef:activeReceipt.receiptKey,
      revision:activeReceipt.receipt.revisionId,digest:activeReceipt.receipt.sourceDigest,expectedGeneration:0});
    assert.equal(explicitMicro.status,'verified','a historical source requires an explicit permitted fixture analysis retry');
  }
  const sourceRaw=await api.debugReadActiveRawPacket(1);assert.equal(sourceRaw.status,'verified');
  const envelope = await portable.exportCurrentScope();
  assert.ok(envelope.records.some(record => String(record.key).includes(':micro-memory-head:')),
    'the source backup contains committed per-turn Micro records');
    assert.equal(portable.pluginVersion, api.version);
    assert.equal(envelope.plugin.version, api.version);
  assert.equal(envelope.source.chatId, 'libra-portable-source');
  assert.equal(envelope.lineage.batches.length, 2);
  assert.equal(envelope.records.some(record => record.key === foreignKey), false, 'backup excludes foreign chat storage');
  assert.ok(envelope.records.some(record => record.key === correctionJournalKey), 'backup includes the correction journal');
  assert.ok(envelope.records.some(record => record.key === correctionMetaKey), 'backup includes the correction summary metadata');
  assert.ok(envelope.records.some(record => record.key === correctionCommitKey), 'backup includes the correction commit marker');

  const pendingCorrectionEnvelope = structuredClone(envelope);
  const pendingCommitRecord = pendingCorrectionEnvelope.records.find(record => record.key === correctionCommitKey);
  const pendingCommitValue = typeof pendingCommitRecord.value === 'string' ? JSON.parse(pendingCommitRecord.value) : structuredClone(pendingCommitRecord.value);
  pendingCommitValue.status = 'pending';
  pendingCommitRecord.value = typeof pendingCommitRecord.value === 'string' ? JSON.stringify(pendingCommitValue) : pendingCommitValue;
  resignEnvelope(pendingCorrectionEnvelope);
  await assert.rejects(portable.validateBackup(pendingCorrectionEnvelope), /portable_backup_state_correction_commit_mismatch/,
    'portable validation rejects an interrupted pending correction transaction');

  const splitCorrectionEnvelope = structuredClone(envelope);
  const splitJournalRecord = splitCorrectionEnvelope.records.find(record => record.key === correctionJournalKey);
  const splitJournalValue = typeof splitJournalRecord.value === 'string' ? JSON.parse(splitJournalRecord.value) : structuredClone(splitJournalRecord.value);
  splitJournalValue.revision += 1;
  splitJournalRecord.value = typeof splitJournalRecord.value === 'string' ? JSON.stringify(splitJournalValue) : splitJournalValue;
  resignEnvelope(splitCorrectionEnvelope);
  await assert.rejects(portable.validateBackup(splitCorrectionEnvelope), /portable_backup_state_correction_meta_mismatch/,
    'portable validation rejects a J-new/M-old split pair');

  const missingCommitEnvelope = structuredClone(envelope);
  missingCommitEnvelope.records = missingCommitEnvelope.records.filter(record => record.key !== correctionCommitKey);
  missingCommitEnvelope.inventory.dependencyKeys = missingCommitEnvelope.inventory.dependencyKeys
    .filter(storageKey => storageKey !== correctionCommitKey);
  resignEnvelope(missingCommitEnvelope);
  await assert.rejects(portable.validateBackup(missingCommitEnvelope), /portable_backup_state_correction_transaction_incomplete/,
    'portable validation rejects a journal/meta pair without its commit marker');
  const interruptedAdoptionEnvelope = structuredClone(envelope);
  interruptedAdoptionEnvelope.records.push({
    key: `${scopePrefix}:canonical-adoption-transaction:portable-fixture`,
    value: JSON.stringify({
      schema: 'libra.canonical_adoption_transaction.v1', scopeKey: manifest.scopeKey,
      jobId: 'portable-fixture', candidateKey: `${scopePrefix}:memory:6:r2`, state: 'writing'
    }),
    mode: 'replace'
  });
  resignEnvelope(interruptedAdoptionEnvelope);
  await assert.rejects(portable.validateBackup(interruptedAdoptionEnvelope), /portable_backup_canonical_adoption_incomplete/,
    'portable validation rejects an interrupted canonical adoption transaction');
  const invalidScopeEnvelope = structuredClone(envelope);
  const invalidMemoryRecord = invalidScopeEnvelope.records.find(record => record.key === manifest.memories['1'].key);
  const invalidMemoryValue = typeof invalidMemoryRecord.value === 'string' ? JSON.parse(invalidMemoryRecord.value) : structuredClone(invalidMemoryRecord.value);
  invalidMemoryValue.scopeKey = 'foreign-scope';
  invalidMemoryRecord.value = typeof invalidMemoryRecord.value === 'string' ? JSON.stringify(invalidMemoryValue) : invalidMemoryValue;
  resignEnvelope(invalidScopeEnvelope);
  await assert.rejects(portable.validateBackup(invalidScopeEnvelope), /portable_backup_memory_scope_mismatch/, 'graph validation rejects a re-signed memory whose value belongs to another scope');
  const invalidVectorEnvelope = structuredClone(envelope);
  const invalidVectorRecord = invalidVectorEnvelope.records.find(record => String(record.key).includes(':vector:portable_mem_1:r1:'));
  const invalidVectorValue = typeof invalidVectorRecord.value === 'string' ? JSON.parse(invalidVectorRecord.value) : structuredClone(invalidVectorRecord.value);
  invalidVectorValue.scopeKey = 'foreign-scope';
  invalidVectorRecord.value = typeof invalidVectorRecord.value === 'string' ? JSON.stringify(invalidVectorValue) : invalidVectorValue;
  resignEnvelope(invalidVectorEnvelope);
  await assert.rejects(portable.validateBackup(invalidVectorEnvelope), /portable_backup_vector_scope_mismatch/, 'graph validation rejects a re-signed vector owned by another scope');

  const sourceMemoryKey = manifest.memories['1'].key;
  const originalSourceMemory = values.get(sourceMemoryKey);
  values.set(sourceMemoryKey, JSON.stringify({ ...parsed(sourceMemoryKey), text: 'MUTATED AFTER BACKUP' }));
  const extraKey = `${scopePrefix}:memory:11:r1`;
  const sharedDependencyKey = 'libra:v1:shared-archive:shared-by-two-chats:memory:test:r1';
  const legacyOwnedKey = `lmai:legacy-owned:${manifest.scopeKey}`;
  values.set(sharedDependencyKey, JSON.stringify({ schema: 'libra.canonical_memory.v1', scopeKey: 'archive:shared-by-two-chats', marker: 'shared-survives' }));
  values.set(extraKey, JSON.stringify({ scopeKey: manifest.scopeKey, marker: 'remove-on-exact-restore', sharedDependencyKey }));
  values.set(legacyOwnedKey, JSON.stringify({ scopeKey: manifest.scopeKey, chatId: manifest.chatId, characterId: manifest.characterId, marker: 'remove-legacy-on-exact-restore' }));
  values.set(foreignKey, JSON.stringify({ schema: 'libra.manifest.v1', scopeKey: 'foreign-scope', marker: 'survive', sharedDependencyKey }));
  const restored = await portable.restoreCurrentScope(envelope);
  assert.equal(restored.ok, true);
  assert.equal(JSON.stringify((await api.debugReadActiveRawPacket(1)).packet),JSON.stringify(sourceRaw.packet));
  assert.equal(values.get(sourceMemoryKey), originalSourceMemory, 'same-chat restore exactly replaces backed-up records');
  assert.equal(values.has(extraKey), false, 'same-chat restore removes current-scope records absent from backup');
  assert.equal(values.has(legacyOwnedKey), false, 'same-chat restore removes legacy value-owned records absent from backup');
  assert.equal(parsed(foreignKey).marker, 'survive', 'same-chat restore never removes another chat scope');
  assert.equal(parsed(sharedDependencyKey).marker, 'shared-survives', 'same-chat restore never deletes a shared dependency that another chat can reference');
  assert.ok(restored.checkpointKey, 'same-chat restore creates a durable pre-restore checkpoint');
  assert.equal(restored.checkpointRetained, false, 'successful restore releases its transactional checkpoint');
  assert.equal(values.has(restored.checkpointKey), false, 'successful restore does not accumulate full-scope snapshots');

  const interruptedId = 'restore_interrupted_fixture';
  const interruptedCheckpointKey = `${scopePrefix}:portable-restore-snapshot:${interruptedId}`;
  const interruptedJournalKey = `${scopePrefix}:portable-restore-journal:${interruptedId}`;
  values.set(interruptedCheckpointKey, {
    schema: 'libra.portable_restore_snapshot.v1', checkpointId: interruptedId,
    scopeKey: manifest.scopeKey, chatId: manifest.chatId, characterId: manifest.characterId,
    createdAt: new Date().toISOString(), entries: [{ key: sourceMemoryKey, exists: true, value: originalSourceMemory }]
  });
  values.set(interruptedJournalKey, {
    schema: 'libra.portable_restore_journal.v1', checkpointId: interruptedId,
    checkpointKey: interruptedCheckpointKey, scopeKey: manifest.scopeKey,
    state: 'writing', updatedAt: new Date().toISOString()
  });
  values.set(sourceMemoryKey, JSON.stringify({ ...parsed(sourceMemoryKey), text: 'PARTIAL CRASH WRITE' }));
  const recovered = await portable.recoverInterruptedRestore();
  assert.equal(recovered.recovered, 1);
  assert.equal(recovered.failed, 0);
  assert.equal(values.get(sourceMemoryKey), originalSourceMemory, 'interrupted restore journal rolls back from its durable snapshot');
  assert.equal(values.has(interruptedCheckpointKey), false, 'successful startup recovery removes its checkpoint');
  assert.equal(values.has(interruptedJournalKey), false, 'successful startup recovery removes its journal');

  const finalizeRetryId = 'restore_finalize_retry_fixture';
  const finalizeRetryCheckpointKey = `${scopePrefix}:portable-restore-snapshot:${finalizeRetryId}`;
  const finalizeRetryJournalKey = `${scopePrefix}:portable-restore-journal:${finalizeRetryId}`;
  values.set(finalizeRetryCheckpointKey, {
    schema: 'libra.portable_restore_snapshot.v1', checkpointId: finalizeRetryId,
    scopeKey: manifest.scopeKey, chatId: manifest.chatId, characterId: manifest.characterId,
    createdAt: new Date().toISOString(), entries: [{ key: sourceMemoryKey, exists: true, value: originalSourceMemory }]
  });
  values.set(finalizeRetryJournalKey, {
    schema: 'libra.portable_restore_journal.v1', checkpointId: finalizeRetryId,
    checkpointKey: finalizeRetryCheckpointKey, scopeKey: manifest.scopeKey,
    state: 'writing', updatedAt: new Date().toISOString()
  });
  values.set(sourceMemoryKey, JSON.stringify({ ...parsed(sourceMemoryKey), text: 'SECOND PARTIAL CRASH WRITE' }));
  let rejectedRecoveryJournal = false;
  rejectSet = (storageKey, raw) => {
    if (storageKey !== finalizeRetryJournalKey || rejectedRecoveryJournal) return false;
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (value?.state !== 'recovered_after_interruption') return false;
    rejectedRecoveryJournal = true;
    return true;
  };
  const failedFinalize = await portable.recoverInterruptedRestore();
  assert.equal(failedFinalize.failed, 1, 'journal finalization failure is reported');
  assert.equal(values.get(finalizeRetryCheckpointKey).recoveryState, 'recovery_applied', 'checkpoint records that data rollback already completed');
  const postRecoveryEdit = JSON.stringify({ ...parsed(sourceMemoryKey), text: 'NEW DATA AFTER RECOVERY' });
  values.set(sourceMemoryKey, postRecoveryEdit);
  rejectSet = null;
  const finalizedWithoutReplay = await portable.recoverInterruptedRestore();
  assert.equal(finalizedWithoutReplay.failed, 0);
  assert.equal(values.get(sourceMemoryKey), postRecoveryEdit, 'retry finalizes the journal without replaying the old checkpoint over newer data');
  assert.equal(values.has(finalizeRetryCheckpointKey), false);
  assert.equal(values.has(finalizeRetryJournalKey), false);

  selectChat(1);
  const migrationPreview = await portable.previewImport(envelope);
  assert.equal(migrationPreview.modes.restore_same_scope.available, false);
  assert.equal(migrationPreview.modes.import_as_predecessor_archive.available, true);
  assert.equal(migrationPreview.modes.reconstruct_native_copy.available, false);
  const sharedKeysBeforeFailedMigration = new Set(Array.from(values.keys()).filter(key => String(key).startsWith('libra:v1:shared-archive:')));
  const migrationTargetManifestKey = `libra:v1:scope:${migrationPreview.target.scopeKey}:manifest`;
  let rejectedMigrationManifest = false;
  rejectSet = storageKey => {
    if (storageKey !== migrationTargetManifestKey || rejectedMigrationManifest) return false;
    rejectedMigrationManifest = true;
    return true;
  };
  await assert.rejects(portable.importAsPredecessorArchive(envelope), /pluginStorage|write|저장/, 'archive adoption failure rolls back shared records');
  rejectSet = null;
  assert.deepEqual(new Set(Array.from(values.keys()).filter(key => String(key).startsWith('libra:v1:shared-archive:'))), sharedKeysBeforeFailedMigration, 'failed archive adoption restores the exact shared-key set');
  assert.equal(Array.from(values.keys()).some(key => String(key).startsWith(`libra:v1:scope:${migrationPreview.target.scopeKey}:portable-import-journal:`)), false, 'failed archive adoption cleans its import journal');
  const migrated = await portable.importAsPredecessorArchive(envelope);
  assert.equal(migrated.ok, true);
  assert.equal(migrated.records, 3);
  const [migrationManifestStorageKey, migrationRaw] = scopeManifestEntry('libra-portable-migration');
  const migrationManifest = typeof migrationRaw === 'string' ? JSON.parse(migrationRaw) : migrationRaw;
  assert.equal(Object.keys(migrationManifest.memories || {}).length, 0, 'migration does not impersonate current target turns');
  assert.equal(migrationManifest.inheritedMemories.length, 3, 'source current and inherited memories become permanent predecessor history');
  assert.ok(migrationManifest.portableImports.some(row => row.mode === 'import_as_predecessor_archive' && row.verified && row.durable));
  const importedMicroRef = migrationManifest.inheritedMicroArchives?.[0];
  assert.equal(importedMicroRef?.schema, 'libra.micro_handoff_archive_ref.v1');
  assert.equal(importedMicroRef.sessionEpoch, -1);
  assert.equal(parsed(importedMicroRef.archiveKey).recordCount, importedMicroRef.recordCount,
    'the imported Micro archive is physically stored with its owner inventory');
  const importedMicroReceipt = migrationManifest.portableImports.find(row => row.mode === 'import_as_predecessor_archive');
  assert.equal(importedMicroReceipt.microArchiveCount, 1);
  assert.equal(importedMicroReceipt.microOwnerRecords, importedMicroRef.recordCount);
  const inheritedMicroQuery = 'Assistant confirms portable fact 2.';
  const inheritedMicroRecall = await api.previewUnifiedMemoryRecall(inheritedMicroQuery);
  // The unified engine does not yet project inherited Micro archives into a recall corpus
  // (`inherited_micro_projection_not_yet_supported`). The archive stays physically intact (checked above); recall must
  // not pretend to serve its detail and must disclose the incomplete Micro coverage instead.
  assert.ok(!(inheritedMicroRecall.memories || []).some(row => row.memory?.kind === 'micro'
    && row.memory.text === inheritedMicroQuery && row.memory.turnRange?.start === 2),
    'recall does not claim to serve the predecessor Micro detail before inherited Micro projection exists');
  const inheritedMicroCoverage = inheritedMicroRecall.unifiedExecution?.coverage;
  assert.equal(inheritedMicroRecall.unifiedExecution?.queryComplete, false, 'recall with an inherited Micro archive is not reported complete');
  assert.ok((inheritedMicroCoverage?.familyIncompleteReasons || []).some(row => row.family === 'micro'
    && row.reasons.includes('inherited_micro_projection_not_yet_supported')),
    'recall discloses that the inherited Micro archive is not yet projected');
  migrationManifest.portableImports.find(row => row.mode === 'import_as_predecessor_archive').records = 0;
  values.set(migrationManifestStorageKey, JSON.stringify(migrationManifest));
  const missingArchiveMemoryKey = migrationManifest.inheritedMemories[0].key;
  values.delete(missingArchiveMemoryKey);
  const repairedMigration = await portable.importAsPredecessorArchive(envelope);
  assert.equal(repairedMigration.ok, true, 'a damaged completed archive receipt and corrupted record count are repaired in place');
  assert.equal(values.has(missingArchiveMemoryKey), true, 'archive repair recreates the missing owned record');
  const [, repairedMigrationRaw] = scopeManifestEntry('libra-portable-migration');
  const repairedMigrationManifest = typeof repairedMigrationRaw === 'string' ? JSON.parse(repairedMigrationRaw) : repairedMigrationRaw;
  const migratedVectorMemory = parsed(repairedMigrationManifest.inheritedMemories.find(ref => ref.embeddingStatus === 'ready').key);
  assert.equal(migratedVectorMemory.embedding.status, 'ready', 'packed portable vectors remain ready during archive migration');
  assert.equal(parsed(migratedVectorMemory.embedding.vectorKey).scopeKey, migratedVectorMemory.scopeKey, 'archive vector is rebound to the archive memory owner');

  selectChat(2);
  const copyPreview = await portable.previewImport(envelope);
  assert.equal(copyPreview.modes.restore_same_scope.available, false);
  assert.equal(copyPreview.modes.reconstruct_native_copy.available, true);
  assert.deepEqual(Array.from(copyPreview.matchedStarts), [1, 6]);
  const copyScopePrefix = `libra:v1:scope:${copyPreview.target.scopeKey}`;
  const protectedMemoryKey = `${copyScopePrefix}:memory:1:r1`;
  const copyContinuityKey = `${copyScopePrefix}:continuity-state`;
  const assertPendingStateReceipt = (receipt, label) => {
    assert.equal(receipt?.continuityRequired, true, `${label}: continuity remains required`);
    assert.equal(receipt?.continuityRebuildPending, true, `${label}: catch-up remains explicitly pending`);
    assert.equal(receipt?.continuityStateAuthority, 'none_pending', `${label}: no Head authority may be claimed while pending`);
    assert.equal(receipt?.stateTransferRebuild?.pending, true, `${label}: nested rebuild receipt remains pending`);
    assert.notEqual(receipt?.stateTransferRebuild?.ok, true, `${label}: nested rebuild may not claim success`);
  };
  let rejectedContinuityWrite = false;
  const localVectorKeysBeforeFailedCopy = new Set(Array.from(values.keys()).filter(key => String(key).startsWith('libra:v1:local-vector:')));
  rejectSet = storageKey => {
    if (storageKey !== copyContinuityKey || rejectedContinuityWrite) return false;
    rejectedContinuityWrite = true;
    return true;
  };
  const pendingStateCopy = await portable.reconstructCopiedChat(envelope);
  rejectSet = null;
  assert.equal(pendingStateCopy.ok, true,
    'derived-state persistence failure must fail open after durable canonical copy adoption');
  assertPendingStateReceipt(pendingStateCopy.receipt, 'continuity-write-failure receipt');
  const [, pendingStateManifestRaw] = scopeManifestEntry('libra-portable-copy');
  const pendingStateManifest = typeof pendingStateManifestRaw === 'string' ? JSON.parse(pendingStateManifestRaw) : pendingStateManifestRaw;
  const durablePendingStateReceipt = pendingStateManifest.portableImports.find(row => row.importId === pendingStateCopy.receipt.importId
    && row.mode === 'reconstruct_native_copy' && row.verified && row.durable);
  assert.ok(durablePendingStateReceipt, 'fail-open canonical copy must durably retain its completion receipt');
  assertPendingStateReceipt(durablePendingStateReceipt, 'durable continuity-write-failure receipt');
  assert.equal(values.has(copyContinuityKey), false,
    'a rejected derived Head write must not manufacture an authoritative continuity state');
  assert.equal(values.has(`${copyScopePrefix}:memory:1:r1`), true, 'canonical memory 1 remains durably adopted');
  assert.equal(values.has(`${copyScopePrefix}:memory:6:r1`), true, 'canonical memory 6 remains durably adopted');
  assert.equal(Array.from(values.keys()).some(key => String(key).startsWith(`${copyScopePrefix}:portable-import-journal:`)), false,
    'successful fail-open completion cleans its import journal');
  for (const storageKey of Array.from(values.keys())) {
    if (String(storageKey).startsWith(copyScopePrefix)) values.delete(storageKey);
    if (String(storageKey).startsWith('libra:v1:local-vector:') && !localVectorKeysBeforeFailedCopy.has(storageKey)) values.delete(storageKey);
  }
  const protectedMemory = { schema: 'libra.canonical_memory.v1', scopeKey: copyPreview.target.scopeKey, memoryId: 'protected_variant', revision: 1, status: 'committed', marker: 'must-survive' };
  values.set(protectedMemoryKey, JSON.stringify(protectedMemory));
  await assert.rejects(portable.reconstructCopiedChat(envelope), /portable_chat_copy_target_memory_key_conflict/, 'copy recovery fails closed instead of overwriting an inactive target variant');
  assert.equal(parsed(protectedMemoryKey).marker, 'must-survive');
  values.delete(protectedMemoryKey);
  const importId = `portable_${String(envelope.integrity?.digest || envelope.integrity?.fallbackDigest || '').slice(0, 32)}`;
  const interruptedImportJournalKey = `${copyScopePrefix}:portable-import-journal:${importId}`;
  const outOfScopeJournalKey = interruptedImportJournalKey;
  values.set(outOfScopeJournalKey, JSON.stringify({
    schema: 'libra.portable_import_journal.v1', importId, mode: 'reconstruct_native_copy',
    scopeKey: copyPreview.target.scopeKey, state: 'writing', updatedAt: new Date().toISOString(),
    entries: [{ key: foreignKey, exists: true, value: parsed(foreignKey) }]
  }));
  await assert.rejects(portable.reconstructCopiedChat(envelope), /portable_import_interrupted_recovery_failed/, 'an out-of-scope journal is rejected before any rollback write');
  assert.equal(parsed(foreignKey).marker, 'survive', 'journal recovery cannot rewrite another chat scope');
  values.delete(outOfScopeJournalKey);
  const interruptedRawBaseline = JSON.stringify({ schema: 'libra.canonical_memory.v1', scopeKey: copyPreview.target.scopeKey, marker: 'raw-baseline' }, null, 2);
  values.set(protectedMemoryKey, '{malformed-partial-crash-write');
  values.set(interruptedImportJournalKey, JSON.stringify({
    schema: 'libra.portable_import_journal.v1', importId, mode: 'reconstruct_native_copy',
    scopeKey: copyPreview.target.scopeKey, state: 'writing', updatedAt: new Date().toISOString(),
    entries: [{ key: protectedMemoryKey, exists: true, rawValue: interruptedRawBaseline }]
  }));
  await assert.rejects(portable.reconstructCopiedChat(envelope), /portable_chat_copy_target_memory_key_conflict/, 'interrupted recovery restores the old key before normal collision preflight');
  assert.equal(values.get(protectedMemoryKey), interruptedRawBaseline, 'interrupted recovery preserves the exact raw pluginStorage value');
  values.delete(protectedMemoryKey);
  values.set(protectedMemoryKey, JSON.stringify({ schema: 'libra.canonical_memory.v1', scopeKey: copyPreview.target.scopeKey, marker: 'orphan-from-crash' }));
  values.set(interruptedImportJournalKey, JSON.stringify({
    schema: 'libra.portable_import_journal.v1', importId, mode: 'reconstruct_native_copy',
    scopeKey: copyPreview.target.scopeKey, state: 'writing', updatedAt: new Date().toISOString(),
    entries: [{ key: protectedMemoryKey, exists: false, value: null }]
  }));
  const copied = await portable.reconstructCopiedChat(envelope);
  assert.equal(copied.ok, true);
  const copiedRaw=await api.debugReadActiveRawPacket(1);assert.equal(copiedRaw.status,'verified');
  assert.equal(JSON.stringify(copiedRaw.packet),JSON.stringify(sourceRaw.packet),'portable native copy preserves exact immutable origin raw');
  assert.notEqual(copiedRaw.rawPacketRef.scopeKey,sourceRaw.rawPacketRef.scopeKey);
  assert.equal(values.has(interruptedImportJournalKey), false, 'retry first recovers and removes an interrupted import journal');
  assert.deepEqual(Array.from(copied.copiedStarts), [1, 6]);
  const [, copyRaw] = scopeManifestEntry('libra-portable-copy');
  const copyManifest = typeof copyRaw === 'string' ? JSON.parse(copyRaw) : copyRaw;
  assert.equal(Object.keys(copyManifest.memories || {}).length, 2);
  for (const ref of Object.values(copyManifest.memories)) {
    const memory = parsed(ref.key);
    assert.equal(memory.scopeKey, copyManifest.scopeKey);
    assert.equal(memory.nativeCopiedFromScopeKey, envelope.source.scopeKey);
  }
  const durableCopyReceipt = copyManifest.portableImports.find(row => row.mode === 'reconstruct_native_copy'
    && row.importId === copied.receipt.importId && row.verified && row.durable);
  assert.ok(durableCopyReceipt, 'completion manifest must retain the verified durable native-copy receipt');
  const copiedMicroHeadKeys = Array.from(values.keys()).filter(storageKey =>
    String(storageKey).startsWith(`${copyScopePrefix}:micro-memory-head:`));
  assert.ok(copiedMicroHeadKeys.length > 0,
    'a native reconstructed copy carries source-bound active Micro heads into the matching target chat');
  const copiedMicroRecall = await api.previewUnifiedMemoryRecall('Assistant confirms portable fact 2.');
  assert.ok((copiedMicroRecall.memories || []).some(row => row.memory?.kind === 'micro'
    && row.memory.text === 'Assistant confirms portable fact 2.' && row.memory.turnRange?.start === 2),
    'the native copy recalls a precise predecessor scene from its own verified Micro records');
  assertPendingStateReceipt(copied.receipt, 'returned native-copy receipt');
  assertPendingStateReceipt(durableCopyReceipt, 'durable native-copy receipt readback');
  assert.equal(values.has(copyContinuityKey), false,
    'a verified pending receipt is valid without manufacturing or accepting a current authoritative Head');
  assert.equal(copied.continuityStateCopied, copied.receipt.stateTransferRebuild.seedPersisted,
    'the compatibility seed flag describes only durable last-known fallback persistence, not target-chain authority');
  assert.equal(copyManifest.inheritedMemories.length, 1, 'copy recovery carries source predecessor history as an inherited archive');
  const missingCopiedInheritedKey = copyManifest.inheritedMemories[0].key;
  values.delete(missingCopiedInheritedKey);
  const repairedCopiedArchive = await portable.reconstructCopiedChat(envelope);
  assert.equal(repairedCopiedArchive.ok, true, 'copy receipt repair detects a missing inherited archive record');
  const [, repairedCopyArchiveRaw] = scopeManifestEntry('libra-portable-copy');
  const repairedCopyArchiveManifest = typeof repairedCopyArchiveRaw === 'string' ? JSON.parse(repairedCopyArchiveRaw) : repairedCopyArchiveRaw;
  const repairedInheritedRef = repairedCopyArchiveManifest.inheritedMemories.find(ref => ref.handoffTransferId === importId);
  assert.ok(repairedInheritedRef?.key && values.has(repairedInheritedRef.key), 'copy repair creates a new immutable archive layer for the missing predecessor record');
  assert.notEqual(repairedInheritedRef.key, missingCopiedInheritedKey, 'copy repair does not mutate or impersonate the damaged immutable layer');
  const copiedFirstKey = copyManifest.memories['1'].key;
  const copiedFirstMemory = parsed(copiedFirstKey);
  const copiedVectorKey = copiedFirstMemory.embedding.vectorKey;
  const corruptedMemoryRaw = JSON.stringify({ ...copiedFirstMemory, text: 'CORRUPTED RECEIPT-OWNED MEMORY' });
  values.set(copiedFirstKey, corruptedMemoryRaw);
  const alternateVectorRaw = JSON.stringify({ ...parsed(copiedVectorKey), rollbackMarker: 'exact-raw-vector-snapshot' }, null, 2);
  values.set(copiedVectorKey, alternateVectorRaw);
  rejectedContinuityWrite = false;
  rejectSet = storageKey => {
    if (storageKey !== copyContinuityKey || rejectedContinuityWrite) return false;
    rejectedContinuityWrite = true;
    return true;
  };
  const repairedWithPendingState = await portable.reconstructCopiedChat(envelope);
  rejectSet = null;
  assert.equal(repairedWithPendingState.ok, true,
    'canonical receipt repair remains durable when the derived target-chain state write fails open');
  assert.equal(repairedWithPendingState.receipt.continuityRebuildPending, true,
    'the fail-open derived-state boundary must remain visible for explicit catch-up');
  assertPendingStateReceipt(repairedWithPendingState.receipt, 'returned repair receipt');
  const [, pendingRepairRaw] = scopeManifestEntry('libra-portable-copy');
  const pendingRepairManifest = typeof pendingRepairRaw === 'string' ? JSON.parse(pendingRepairRaw) : pendingRepairRaw;
  const durablePendingRepair = pendingRepairManifest.portableImports.find(row => row.importId === repairedWithPendingState.receipt.importId
    && row.mode === 'reconstruct_native_copy' && row.verified && row.durable);
  assert.ok(durablePendingRepair, 'repair completion must durably persist its pending state receipt');
  assertPendingStateReceipt(durablePendingRepair, 'durable repair receipt readback');
  assert.notEqual(values.get(copiedFirstKey), corruptedMemoryRaw, 'successful semantic repair replaces corrupted receipt-owned canon');
  assert.notEqual(values.get(copiedVectorKey), alternateVectorRaw, 'successful semantic repair restores the backed-up vector contract');
  values.delete(copiedFirstKey);
  let rejectedJournalCleanup = false;
  rejectRemove = storageKey => {
    if (storageKey !== interruptedImportJournalKey || rejectedJournalCleanup) return false;
    rejectedJournalCleanup = true;
    return true;
  };
  const repairedCopy = await portable.reconstructCopiedChat(envelope);
  rejectRemove = null;
  assert.equal(repairedCopy.ok, true, 'a durable receipt with missing canonical data is selectively repaired');
  assert.equal(repairedCopy.journalCleanup.cleaned, false, 'journal cleanup rejection is surfaced without rolling back a completed import');
  assert.equal(repairedCopy.warnings[0].stage, 'import_journal_cleanup');
  assert.equal(values.has(interruptedImportJournalKey), true, 'a completed journal is retained for safe startup cleanup');
  assert.equal(parsed(copiedFirstKey).portableImportId, importId, 'repair recreates the receipt-owned canonical record');
  const repairedVectorKey = parsed(copiedFirstKey).embedding.vectorKey;
  values.set(repairedVectorKey, '{malformed-receipt-owned-vector');
  const repairedMalformedVector = await portable.reconstructCopiedChat(envelope);
  assert.equal(repairedMalformedVector.ok, true, 'malformed JSON in a receipt-owned vector enters selective repair instead of aborting preview');
  assert.equal(parsed(repairedVectorKey).portableVectorPayload?.schema, 'libra.local_vector_payload.v1', 'selective repair replaces malformed vector JSON with a durable packed payload');
  assert.equal(parsed(repairedVectorKey).vectorHash, 'fixture-vector', 'selective repair preserves the backed-up vector identity');
  const embeddingDowngradedMemory = parsed(copiedFirstKey);
  embeddingDowngradedMemory.embedding = { status: 'disabled', projectionVersion: 'libra.retrieval_projection.v2' };
  values.set(copiedFirstKey, JSON.stringify(embeddingDowngradedMemory));
  const repairedEmbeddingContract = await portable.reconstructCopiedChat(envelope);
  assert.equal(repairedEmbeddingContract.ok, true, 'receipt repair detects a semantic embedding-status downgrade');
  assert.equal(parsed(copiedFirstKey).embedding.status, 'ready', 'receipt repair restores the backed-up ready embedding contract');
  const provenanceCorruptedMemory = parsed(copiedFirstKey);
  provenanceCorruptedMemory.sourcePairs = [{ user: 'forged', assistant: 'forged' }];
  provenanceCorruptedMemory.branchId = 'forged-branch';
  values.set(copiedFirstKey, JSON.stringify(provenanceCorruptedMemory));
  const repairedProvenance = await portable.reconstructCopiedChat(envelope);
  assert.equal(repairedProvenance.ok, true, 'receipt repair detects corrupted target source provenance');
  assert.notEqual(parsed(copiedFirstKey).branchId, 'forged-branch', 'receipt repair rebinds provenance to the current copied transcript');
  const [copyManifestKey] = scopeManifestEntry('libra-portable-copy');
  const shortenedReceiptManifest = parsed(copyManifestKey);
  shortenedReceiptManifest.portableImports.find(row => row.importId === importId).copiedStarts = [1];
  const copiedSecondKey = shortenedReceiptManifest.memories['6'].key;
  values.set(copyManifestKey, JSON.stringify(shortenedReceiptManifest));
  values.delete(copiedSecondKey);
  const repairedShortenedReceipt = await portable.reconstructCopiedChat(envelope);
  assert.equal(repairedShortenedReceipt.ok, true, 'receipt repair recomputes the expected copied range instead of trusting a shortened receipt');
  assert.equal(values.has(copiedSecondKey), true, 'the omitted receipt range is restored from the backup');
  const legacyReceiptManifest = parsed(copyManifestKey);
  const legacyReceipt = legacyReceiptManifest.portableImports.find(row => row.importId === importId);
  delete legacyReceipt.continuityRequired;
  values.set(copyManifestKey, JSON.stringify(legacyReceiptManifest));
  values.delete(copyContinuityKey);
  const repairedLegacyReceipt = await portable.reconstructCopiedChat(envelope);
  assert.equal(repairedLegacyReceipt.ok, true,
    'legacy receipts normalize missing continuityRequired without inventing an authoritative Head');
  assert.equal(values.has(interruptedImportJournalKey), false, 'the next import safely cleans a retained completed journal');
  assert.equal(repairedLegacyReceipt.skipped, true);
  assert.equal(repairedLegacyReceipt.reason, 'portable_import_already_complete');
  const normalizedLegacyManifest = parsed(copyManifestKey);
  const normalizedLegacyReceipt = normalizedLegacyManifest.portableImports.find(row => row.importId === importId);
  assert.ok(normalizedLegacyReceipt, 'legacy pending receipt remains durably discoverable');
  assert.equal(normalizedLegacyReceipt.continuityRequired, undefined);
  assert.equal(normalizedLegacyReceipt.continuityRebuildPending, true);
  assert.equal(normalizedLegacyReceipt.continuityStateAuthority, 'none_pending');
  assert.equal(values.has(copyContinuityKey), false,
    'pending legacy receipt compatibility must allow Head absence instead of rematerializing false authority');

  selectChat(3);
  const diverged = await portable.previewImport(envelope);
  assert.deepEqual(Array.from(diverged.matchedStarts), [1]);
  assert.equal(diverged.divergenceTurn, 6);

  const emptyEnvelope = structuredClone(envelope);
  const emptyManifestRecord = emptyEnvelope.records.find(record => String(record.key).endsWith(':manifest'));
  const emptyManifest = typeof emptyManifestRecord.value === 'string' ? JSON.parse(emptyManifestRecord.value) : structuredClone(emptyManifestRecord.value);
  emptyManifest.memories = {};
  emptyManifest.inheritedMemories = [];
  emptyManifest.archiveRef = null;
  emptyManifest.portableImports = [];
  emptyManifestRecord.value = typeof emptyManifestRecord.value === 'string' ? JSON.stringify(emptyManifest) : emptyManifest;
  emptyEnvelope.records = [emptyManifestRecord];
  emptyEnvelope.inventory.dependencyKeys = [];
  emptyEnvelope.lineage = { ...emptyEnvelope.lineage, pairCount: 0, batches: [], fingerprint: 'empty' };
  resignEnvelope(emptyEnvelope);
  selectChat(4);
  const emptyPreview = await portable.previewImport(emptyEnvelope);
  assert.equal(emptyPreview.modes.import_as_predecessor_archive.available, false);
  assert.equal(emptyPreview.modes.import_as_predecessor_archive.reason, 'source_memories_missing', 'an empty backup cannot create a meaningless predecessor archive');

  selectChat(1);
  for (const storageKey of [...values.keys()]) {
    if (String(storageKey).startsWith(`${scopePrefix}:`)) values.delete(storageKey);
  }
  const sourceRemovedRecall = await api.previewUnifiedMemoryRecall('Assistant confirms portable fact 3.');
  // Inherited Micro archives are not yet projected by the unified engine: with the original owner removed, recall must
  // neither serve the archive nor report complete coverage; the physical archive itself is verified below.
  assert.ok(!(sourceRemovedRecall.memories || []).some(row => row.memory?.kind === 'micro'
    && row.memory.text === 'Assistant confirms portable fact 3.' && row.memory.turnRange?.start === 3),
    'recall does not claim the imported Micro detail before inherited Micro projection exists');
  assert.equal(sourceRemovedRecall.unifiedExecution?.queryComplete, false);
  assert.ok((sourceRemovedRecall.unifiedExecution?.coverage?.familyIncompleteReasons || []).some(row => row.family === 'micro'
    && row.reasons.includes('inherited_micro_projection_not_yet_supported')),
    'recall discloses the unprojected inherited Micro archive after its original chat owner is removed');
  assert.equal(parsed(importedMicroRef.archiveKey).recordCount, importedMicroRef.recordCount,
    'the imported Micro archive survives removal of the original chat owner with its full owner inventory');
  const originalMicroArchive = values.get(importedMicroRef.archiveKey);
  values.set(importedMicroRef.archiveKey, JSON.stringify({ ...parsed(importedMicroRef.archiveKey), recordCount: 0 }));
  const tamperedMicroRecall = await api.previewUnifiedMemoryRecall('Assistant confirms portable fact 4.');
  assert.equal((tamperedMicroRecall.memories || []).some(row => row.memory?.kind === 'micro'), false,
    'a damaged inherited archive cannot supply Micro evidence');
  values.set(importedMicroRef.archiveKey, originalMicroArchive);

  assert.match(source, /previewPortableImport\(\{ \.\.\.asObject\(input\), importId: bundle\.importId \}\)/, 'derived import IDs are passed into preview for idempotent receipt lookup');

  for (const handler of unloadHandlers.slice().reverse()) { try { await handler(); } catch (_) {} }
  for (const timer of activeTimeouts) clearTimeout(timer);
  for (const timer of activeIntervals) clearInterval(timer);
  process.stdout.write('libra_portable_cross_chat_restore_runtime_test: PASS\n');
})().catch(error => {
  for (const timer of activeTimeouts) clearTimeout(timer);
  for (const timer of activeIntervals) clearInterval(timer);
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});

