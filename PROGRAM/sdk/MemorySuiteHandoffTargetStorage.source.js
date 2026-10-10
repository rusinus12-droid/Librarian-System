/* Target-only handoff storage preparation v1. Authenticated owner handlers only. */
async function prepareMemorySuiteHandoffTargetStorage(api, storage, owner, payload) {
  const readTarget = async () => {
    const character = await api.getCharacter();
    let index = Number(character?.chatPage || 0);
    if (typeof api.getCurrentChatIndex === 'function') index = Number(await api.getCurrentChatIndex());
    const chat = character?.chats?.[index];
    const marker = chat?.memorySessionBridge;
    const target = String(chat?.id || chat?.chatId || chat?.uuid || '');
    const policy = marker?.targetStoragePolicy;
    if (!target || target !== payload.targetChatId || marker?.targetChatId !== target
      || !payload.transferId || marker?.transferId !== payload.transferId
      || !marker.sourceChatId || marker.sourceChatId === target
      || (marker.targetStorageMode !== 'per_owner' && marker.targetStorageMode !== payload.mode)
      || !['plugin_only','server_only'].includes(payload.mode)
      || !policy?.participants?.some(p => p.owner === owner && p.mode === payload.mode)
      || marker.handoffJournal?.transferId !== payload.transferId
      || marker.handoffJournal?.state === 'completed') throw Error('HANDOFF_TARGET_STORAGE_IDENTITY_INVALID');
    return target;
  };
  const target = await readTarget();
  const before = await storage.getConnectionSettings({ force:true });
  const scope = before.scope;
  if (!scope?.scopeId || String(scope.chatId || scope.canonicalChatId || '') !== target) throw Error('HANDOFF_TARGET_STORAGE_SCOPE_MISMATCH');
  if (before.transition || before.migrationRequired) throw Error('HANDOFF_TARGET_STORAGE_TRANSITION_INCOMPLETE');
  if (before.recoveryRequired) throw Error('HANDOFF_TARGET_STORAGE_RECOVERY_REQUIRED');
  if (before.mode !== payload.mode) {
    // Only a new/local route may be prepared; never convert an unrelated server route.
    if (before.mode !== 'plugin_only') throw Error('HANDOFF_TARGET_STORAGE_MODE_CONFLICT');
    await readTarget();
    await storage.setScopeMode(scope, payload.mode);
  }
  await readTarget();
  const after = await storage.getConnectionSettings({ scope, force:true });
  if (after.mode !== payload.mode || after.scope?.scopeId !== scope.scopeId || after.recoveryRequired) throw Error('HANDOFF_TARGET_STORAGE_READBACK_FAILED');
  return { schema:'memory-suite.target-storage-preparation.v1', owner, targetChatId:target, transferId:payload.transferId, mode:after.mode, scope:after.scope, verified:true };
}
/* End target-only handoff storage preparation */
