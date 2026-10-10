'use strict';
// Storage validation only. The server cannot observe a RisuAI transcript and
// MUST NOT turn this descriptive metadata into memory or inheritance authority.
const SCHEMA = 'librarian.host_lineage.v1';

const BINDING_SCHEMA = 'librarian.native_branch_storage_binding.v1';
const bindingFail = code => { throw Object.assign(new Error(`native_branch_storage_binding_${code}`), { statusCode:400, code:'NATIVE_BRANCH_STORAGE_BINDING_INVALID' }); };
function validateNativeBranchStorageBinding(value, ownerRecord = {}, namespace = '') {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema !== BINDING_SCHEMA) bindingFail('schema');
  const textFields=['bindingId','owner','sourceScopeKey','targetScopeKey','sourceMode','targetMode','targetModeOrigin','parentChatId','targetChatId','lineageDigest','status','createdAt','committedAt'];
  for (const key of textFields) if (value[key] != null && (typeof value[key] !== 'string' || value[key].length > 4096)) bindingFail(`field_${key}`);
  if (!value.bindingId || !value.owner || !value.sourceScopeKey || !value.targetScopeKey || !value.parentChatId || !value.targetChatId || !value.lineageDigest) bindingFail('identity_missing');
  if (value.sourceScopeKey === value.targetScopeKey) bindingFail('same_scope');
  if (value.parentChatId === value.targetChatId) bindingFail('same_chat');
  if (namespace && value.owner !== namespace) bindingFail('owner_namespace_mismatch');
  const modes=new Set(['plugin_only','mirror','server_only']);
  if (!modes.has(value.sourceMode) || !modes.has(value.targetMode)) bindingFail('mode');
  if (!['inherited','explicit','migrated'].includes(value.targetModeOrigin)) bindingFail('origin');
  if (!['prepared','complete','pending','failed'].includes(value.status)) bindingFail('status');
  if (!value.createdAt || Number.isNaN(Date.parse(value.createdAt))) bindingFail('created_at');
  if (value.status === 'complete' && (!value.committedAt || Number.isNaN(Date.parse(value.committedAt)))) bindingFail('committed_at');
  const outerTarget = ownerRecord.canonicalChatId || ownerRecord.targetChatId || ownerRecord.chatId;
  const outerSource = ownerRecord.sourceChatId || ownerRecord.copySourceChatId || ownerRecord.copiedFromChatId;
  if (outerTarget && String(outerTarget) !== value.targetChatId) bindingFail('target_chat_mismatch');
  if (outerSource && String(outerSource) !== value.parentChatId) bindingFail('source_chat_mismatch');
  if (value.targetModeOrigin === 'migrated') {
    const m=value.migration;
    if (!m || typeof m !== 'object' || Array.isArray(m) || m.schema !== 'memory-suite.native-branch-storage-migration.v1' || m.migrated !== true) bindingFail('migration_missing');
    if (m.fromMode !== 'plugin_only' || m.toMode !== value.targetMode || m.retainedLocal !== true) bindingFail('migration_mode');
    for (const key of ['localItems','pluginItems','localStorageItems']) if (!Number.isSafeInteger(m[key]) || m[key] < 0) bindingFail(`migration_${key}`);
    if (!m.migratedAt || Number.isNaN(Date.parse(m.migratedAt))) bindingFail('migration_time');
  }
  return value;
}

const fail = code => { throw Object.assign(new Error(`host_lineage_${code}`), { statusCode: 400, code: 'HOST_LINEAGE_METADATA_INVALID' }); };
function validateHostLineage(value, ownerRecord = {}, namespace = '') {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema !== SCHEMA) fail('schema');
  for (const key of ['hostVersion','characterId','hostChatId','kind','status','reason','parentChatId','parentName','forkMessageId','prefixDigest','pathReason']) {
    if (value[key] != null && (typeof value[key] !== 'string' || value[key].length > 512)) fail(`field_${key}`);
  }
  if (!value.hostChatId || !value.characterId) fail('identity_missing');
  if (!['native_branch','independent_chat'].includes(value.kind) || !['verified','unverified','diverged','independent'].includes(value.status)) fail('state');
  for (const key of ['commonPrefixMessages','commonPrefixPairs','canonicalPrefixEnd','partialCanonicalPairs']) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > 10000000) fail(`range_${key}`);
  }
  for (const key of ['markerIndex','forkMessageIndex']) {
    if (!Number.isSafeInteger(value[key]) || value[key] < -2 || value[key] > 10000000) fail(`index_${key}`);
  }
  if (typeof value.pathVerified !== 'boolean' || typeof value.inheritanceEligible !== 'boolean') fail('flags');
  if (!Array.isArray(value.path) || value.path.length > 66 || value.path.some(id => typeof id !== 'string' || !id || id.length > 512)) fail('path');
  if (value.path.length && value.path.at(-1) !== value.hostChatId) fail('path_target');
  const ownerChat = ownerRecord.canonicalChatId || ownerRecord.targetChatId || ownerRecord.chatId;
  const ownerCharacter = ownerRecord.canonicalCharacterId || ownerRecord.characterId;
  if (ownerChat && String(ownerChat) !== value.hostChatId) fail('owner_chat_mismatch');
  if (ownerCharacter && String(ownerCharacter) !== value.characterId) fail('owner_character_mismatch');
  if (value.owner && value.owner !== namespace) fail('owner_namespace_mismatch');
  if (value.canonicalPrefixEnd !== Math.floor(value.commonPrefixPairs / 5) * 5 || value.partialCanonicalPairs !== value.commonPrefixPairs % 5) fail('canonical_prefix');
  if (value.inheritanceEligible && (value.kind !== 'native_branch' || value.status !== 'verified'
    || !value.parentChatId || value.parentChatId === value.hostChatId || !value.forkMessageId
    || value.markerIndex < 1 || value.commonPrefixMessages !== value.markerIndex
    || value.forkMessageIndex !== value.markerIndex - 1 || value.path.length < 2 || value.path.at(-2) !== value.parentChatId)) fail('eligible_claim');
  return value;
}
function validateStoredHostLineage(input, namespace = '') {
  let root = input;
  if (typeof root === 'string') {
    // Do not parse every opaque shard/string. Only JSON carrying a recognized
    // lineage/binding field is inspected, so an ordinary value is never parsed.
    if (!root.includes('"hostLineage"') && !root.includes('"sourceHostLineage"')
      && !root.includes('"storageBinding"') && !root.includes('"nativeBranchStorageBinding"')) return;
    try { root = JSON.parse(root); } catch (_) { return; }
    if (typeof root === 'string') {
      // A JSON-encoded string that itself carries a JSON object must be decoded
      // as well, otherwise a double-encoded receipt bypasses validation.
      if (!root.includes('"hostLineage"') && !root.includes('"sourceHostLineage"')
        && !root.includes('"storageBinding"') && !root.includes('"nativeBranchStorageBinding"')) return;
      try { root = JSON.parse(root); } catch (_) { return; }
    }
  }
  if (!root || typeof root !== 'object' || Array.isArray(root)) return;
  // A bare receipt sent as the whole stored value is validated against its own
  // identity fields, not silently skipped.
  if (root.schema === BINDING_SCHEMA) { validateNativeBranchStorageBinding(root, root, namespace); return; }
  if (root.schema === SCHEMA) { validateHostLineage(root, root, namespace); return; }
  if (root.hostLineage != null) validateHostLineage(root.hostLineage, root, namespace);
  if (root.storageBinding?.schema === BINDING_SCHEMA) validateNativeBranchStorageBinding(root.storageBinding, root, namespace);
  if (root.nativeBranchStorageBinding?.schema === BINDING_SCHEMA) validateNativeBranchStorageBinding(root.nativeBranchStorageBinding, root, namespace);
  if (root.nativeBranchState?.storageBinding?.schema === BINDING_SCHEMA) validateNativeBranchStorageBinding(root.nativeBranchState.storageBinding, { ...root, ...root.nativeBranchState }, namespace);
  for (const key of ['binding','nativeChatCopy','worldline']) {
    const record = root[key];
    if (record?.hostLineage != null) validateHostLineage(record.hostLineage, { ...root, ...record }, namespace);
    if (record?.storageBinding?.schema === BINDING_SCHEMA) validateNativeBranchStorageBinding(record.storageBinding, { ...root, ...record }, namespace);
  }
  // A handoff's source metadata is explicitly bound to SOURCE, not to target.
  const bridge = root.memorySessionBridge || root;
  if (bridge.sourceHostLineage != null) validateHostLineage(bridge.sourceHostLineage,
    { chatId: bridge.sourceChatId, characterId: bridge.sourceCharacterId }, namespace);
}
module.exports = { SCHEMA, BINDING_SCHEMA, validateHostLineage, validateNativeBranchStorageBinding, validateStoredHostLineage };
