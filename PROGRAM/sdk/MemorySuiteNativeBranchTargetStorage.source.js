/* RisuAI native-branch target storage preparation v1. Verified Host Lineage only. */
async function prepareMemorySuiteNativeBranchTargetStorage(input = {}) {
  const storage = input?.storage;
  const owner = String(input?.owner || '').trim().toLowerCase();
  const lineage = input?.lineage && typeof input.lineage === 'object' ? input.lineage : null;
  const sourceScope = input?.sourceScope && typeof input.sourceScope === 'object' ? input.sourceScope : null;
  const targetScope = input?.targetScope && typeof input.targetScope === 'object' ? input.targetScope : null;
  const chatId = scope => String(scope?.chatId || scope?.canonicalChatId || '').trim();
  const characterId = scope => String(scope?.characterId || scope?.canonicalCharacterId || '').trim();
  if (!storage || !owner || !lineage || !sourceScope?.scopeId || !targetScope?.scopeId
    || lineage.schema !== 'librarian.host_lineage.v1' || lineage.kind !== 'native_branch'
    || lineage.status !== 'verified' || lineage.inheritanceEligible !== true
    || String(lineage.parentChatId || '') !== chatId(sourceScope)
    || String(lineage.hostChatId || '') !== chatId(targetScope)
    || sourceScope.scopeId === targetScope.scopeId
    || (characterId(sourceScope) && characterId(targetScope) && characterId(sourceScope) !== characterId(targetScope))) {
    const error = new Error('NATIVE_BRANCH_TARGET_STORAGE_IDENTITY_INVALID');
    error.code = 'NATIVE_BRANCH_TARGET_STORAGE_IDENTITY_INVALID';
    throw error;
  }
  if (typeof storage.getScopeMode !== 'function' || typeof storage.setScopeMode !== 'function'
    || typeof storage.createNativeBranchScopeCapability !== 'function' || typeof storage.openScopeView !== 'function') {
    const error = new Error('NATIVE_BRANCH_TARGET_STORAGE_SDK_UPGRADE_REQUIRED');
    error.code = 'NATIVE_BRANCH_TARGET_STORAGE_SDK_UPGRADE_REQUIRED';
    throw error;
  }
  const sourceState = await storage.getScopeMode(sourceScope);
  const targetBefore = await storage.getScopeMode(targetScope);
  if (sourceState?.scope?.scopeId && sourceState.scope.scopeId !== sourceScope.scopeId) throw new Error('NATIVE_BRANCH_SOURCE_SCOPE_READBACK_MISMATCH');
  if (targetBefore?.scope?.scopeId && targetBefore.scope.scopeId !== targetScope.scopeId) throw new Error('NATIVE_BRANCH_TARGET_SCOPE_READBACK_MISMATCH');
  const sourceMode = String(sourceState?.mode || 'plugin_only');
  // Validate every prerequisite without side effects, and issue the capability,
  // before changing the target mode or migrating data (design contract: an
  // invalid proof or non-durable source must not mutate the child).
  const capability = storage.createNativeBranchScopeCapability({ owner, lineage, sourceScope, targetScope });
  let sourceDurability = null;
  if (sourceMode !== 'plugin_only') {
    if (typeof storage.verifyNativeBranchSourceDurability === 'function') {
      sourceDurability = await storage.verifyNativeBranchSourceDurability({ scope:sourceScope, phase:'native_branch_source' });
    } else if (typeof storage.ensureHandoffReady === 'function') {
      sourceDurability = await storage.ensureHandoffReady({ scope:sourceScope, phase:'native_branch_source' });
    }
    if (sourceDurability?.verified !== true) {
      const error = new Error('NATIVE_BRANCH_SOURCE_STORAGE_NOT_DURABLE');
      error.code = 'NATIVE_BRANCH_SOURCE_STORAGE_NOT_DURABLE';
      throw error;
    }
  }
  let targetMode = String(targetBefore?.mode || 'plugin_only');
  let targetModeOrigin = targetBefore?.explicit === true ? 'explicit' : 'inherited';
  let migration = null;
  if (targetBefore?.explicit !== true && targetMode !== sourceMode) {
    const localInventory = typeof storage.inspectNativeBranchTargetLocalData === 'function'
      ? await storage.inspectNativeBranchTargetLocalData(targetScope)
      : { total:0, plugin:0, local:0, keys:[] };
    await storage.setScopeMode(targetScope, sourceMode, { origin:'inherited', source:'native_branch_inheritance' });
    targetMode = sourceMode;
    if (sourceMode !== 'plugin_only' && Number(localInventory?.total || 0) > 0) {
      targetModeOrigin = 'migrated';
      // Close the local -> server migration durably: the server copy must be
      // read back before the retained local bytes can be retired. A failed
      // readback leaves the local copy as the only (non-authoritative) remnant
      // and must not mark it retired.
      let retirement = null;
      let serverDigest = '';
      if (typeof storage.retireNativeBranchLocalTargetData === 'function') {
        try {
          retirement = await storage.retireNativeBranchLocalTargetData({
            scope:targetScope,
            keys:(Array.isArray(localInventory.keys) ? localInventory.keys : [])
              .filter(row => String(row?.space || 'plugin') === 'plugin')
              .map(row => String(row?.key || ''))
              .filter(Boolean)
          });
          serverDigest = String(retirement?.serverDigest || '');
        } catch (error) {
          const readbackError = new Error('NATIVE_BRANCH_STORAGE_MIGRATION_READBACK_FAILED');
          readbackError.code = 'NATIVE_BRANCH_STORAGE_MIGRATION_READBACK_FAILED';
          readbackError.cause = error;
          throw readbackError;
        }
      }
      migration = {
        schema:'memory-suite.native-branch-storage-migration.v1', migrated:true,
        fromMode:'plugin_only', toMode:sourceMode, retainedLocal:true,
        localItems:Number(localInventory.total || 0), pluginItems:Number(localInventory.plugin || 0),
        localStorageItems:Number(localInventory.local || 0), migratedAt:new Date().toISOString(),
        localDisposition:'retired_after_server_readback', serverDigest,
        retiredAt:String(retirement?.retiredAt || '')
      };
    }
  }
  const targetAfter = await storage.getScopeMode(targetScope);
  if (String(targetAfter?.mode || '') !== targetMode || targetAfter?.scope?.scopeId !== targetScope.scopeId) {
    const error = new Error('NATIVE_BRANCH_TARGET_STORAGE_MODE_READBACK_FAILED');
    error.code = 'NATIVE_BRANCH_TARGET_STORAGE_MODE_READBACK_FAILED';
    throw error;
  }
  if (targetAfter?.recoveryRequired) {
    const error = new Error('NATIVE_BRANCH_TARGET_STORAGE_RECOVERY_REQUIRED');
    error.code = 'NATIVE_BRANCH_TARGET_STORAGE_RECOVERY_REQUIRED';
    throw error;
  }
  const sourceView = storage.openScopeView(sourceScope, { capability, access:'read' });
  const targetView = storage.openScopeView(targetScope, { capability, access:'readwrite' });
  return {
    schema:'memory-suite.native-branch-storage-preparation.v1', owner,
    sourceScope:{ ...sourceScope }, targetScope:{ ...targetScope }, sourceMode,
    targetMode:String(targetAfter.mode || targetMode), targetModeOrigin,
    lineageDigest:String(lineage.prefixDigest || ''), verified:true, sourceDurability,
    capability, sourceView, targetView,
    receipt:{
      schema:'librarian.native_branch_storage_binding.v1',
      bindingId:`${owner}:${String(sourceScope.scopeKey || sourceScope.scopeId)}->${String(targetScope.scopeKey || targetScope.scopeId)}:${String(lineage.prefixDigest || '')}`, owner,
      sourceScopeKey:String(sourceScope.scopeKey || sourceScope.scopeId), targetScopeKey:String(targetScope.scopeKey || targetScope.scopeId),
      sourceMode, targetMode:String(targetAfter.mode || targetMode), targetModeOrigin,
      parentChatId:chatId(sourceScope), targetChatId:chatId(targetScope), lineageDigest:String(lineage.prefixDigest || ''),
      migration, status:'prepared', createdAt:new Date().toISOString(), committedAt:''
    }
  };
}
/* End RisuAI native-branch target storage preparation */
