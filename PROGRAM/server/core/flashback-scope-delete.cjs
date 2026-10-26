'use strict';
const crypto = require('node:crypto');
const parse = value => { try { return typeof value === 'string' ? JSON.parse(value) : value; } catch (_) { return null; } };
const fail = code => { throw Object.assign(new Error(code), { statusCode:409, code }); };
const registryKey = 'vector_rag_memory:scope_registry:v2';
const protectedRecord = r => r?.permanentSessionHistory === true || r?.inheritedSessionHistory === true
  || r?.historicalProtection === 'permanent_session_history' || !!String(r?.inheritedFromScopeKey || r?.clonedFromScopeKey || '').trim();
module.exports = ({ snapshot, getRepository, backup, canStart, getProtection, onDeleted }) => {
  const plans = new Map();
  let busy = false;
  const inspect = async (principal, body) => {
    const view = await snapshot(principal, { scopeKey:body.scopeKey, dataInstanceId:body.dataInstanceId, epoch:body.epoch });
    if (!view.complete || !view.inventoryComplete || !view.scopeVerified) fail('FLASHBACK_SCOPE_DELETE_INCOMPLETE');
    const protection = getProtection(body.scopeKey);
    if (protection?.pinned || protection?.referenceCount > 0 || protection?.classification === 'referenced_ancestor') fail('FLASHBACK_SCOPE_DELETE_PROTECTED');
    const repo = getRepository();
    const heads = repo.list('plugin', 'vector_rag_memory:scope:').records.filter(r => !r.tombstone && r.key.endsWith(':manifest:v2'));
    for (const row of heads) {
      const manifest = parse(repo.get('plugin', row.key).value);
      if (!manifest?.scopeKey) fail('FLASHBACK_SCOPE_DELETE_REFERENCE_UNVERIFIED');
      if (manifest.scopeKey !== body.scopeKey && manifest.archiveRef?.archiveScopeKey === body.scopeKey) fail('FLASHBACK_SCOPE_DELETE_REFERENCED');
    }
    for (const row of view.values) {
      const value = parse(row.value);
      if ([...(value?.records || []), ...(value?.retiredRecords || [])].some(protectedRecord)) fail('FLASHBACK_SCOPE_DELETE_PROTECTED_HISTORY');
    }
    const registry = repo.get('plugin', registryKey), parsed = registry.exists && !registry.tombstone ? parse(registry.value) : null;
    if (registry.exists && !registry.tombstone && (!parsed || !Array.isArray(parsed.scopes))) fail('FLASHBACK_SCOPE_DELETE_REGISTRY_UNVERIFIED');
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify([view.fingerprint,registry.revision,registry.digest,registry.tombstone])).digest('hex');
    return { view, registry, parsed, fingerprint };
  };
  return async (principal, action, body, requestScopeId) => {
    if (principal?.namespace !== 'flashback' || !principal.roles?.includes('owner')) fail('FLASHBACK_SCOPE_DELETE_OWNER_REQUIRED');
    if (!body || requestScopeId !== body.scopeKey || !canStart()) fail('FLASHBACK_SCOPE_DELETE_AUTHORITY_CHANGED');
    for (const [id, plan] of plans) if (plan.expiresAt < Date.now()) plans.delete(id);
    if (action === 'plan') {
      const current = await inspect(principal, body);
      const plan = { schema:'flashback.scope-delete-plan.v1', planId:crypto.randomUUID(), scopeKey:body.scopeKey,
        dataInstanceId:body.dataInstanceId, epoch:body.epoch, fingerprint:current.fingerprint, expiresAt:Date.now()+120000 };
      plans.set(plan.planId, plan);
      return { ...plan };
    }
    const plan = plans.get(body.planId);
    if (action !== 'execute' || !plan || plan.scopeKey !== body.scopeKey || plan.dataInstanceId !== body.dataInstanceId
      || plan.epoch !== body.epoch || plan.fingerprint !== body.fingerprint) fail('FLASHBACK_SCOPE_DELETE_PLAN_STALE');
    if (plan.receipt) return { ...plan.receipt };
    if (busy) fail('FLASHBACK_SCOPE_DELETE_BUSY');
    busy = true;
    const repo = getRepository();
    try {
      let current = await inspect(principal, body);
      if (current.fingerprint !== plan.fingerprint) fail('FLASHBACK_SCOPE_DELETE_SOURCE_CHANGED_BEFORE_BACKUP');
      const key = current.view.records.find(r => r.name === 'manifest:v2').key;
      repo.writerFence.verify(key, body.fence);
      const saved = await backup('manual', 'pre-flashback-scope-delete');
      if (saved?.ok !== true || !saved.result?.id) fail('FLASHBACK_SCOPE_DELETE_BACKUP_UNVERIFIED');
      current = await inspect(principal, body);
      if (!canStart() || plan.expiresAt < Date.now() || current.fingerprint !== plan.fingerprint) fail('FLASHBACK_SCOPE_DELETE_SOURCE_CHANGED_AFTER_BACKUP');
      const mutations = current.view.records.filter(r => !r.tombstone).map(r => ({ kind:'remove', space:r.space, key:r.key,
        expectedRevision:r.revision, expectedDigest:r.digest, expectedExists:true, expectedTombstone:false }));
      if (current.parsed?.scopes.some(r => r.scopeKey === plan.scopeKey)) {
        const value = { ...current.parsed, scopes:current.parsed.scopes.filter(r => r.scopeKey !== plan.scopeKey) };
        mutations.push({ kind:'set', space:'plugin', key:registryKey, value:typeof current.registry.value === 'string' ? JSON.stringify(value) : value,
          expectedRevision:current.registry.revision, expectedDigest:current.registry.digest, expectedExists:true, expectedTombstone:false });
      }
      repo.applyConditionalBatch(mutations, { fence:body.fence, operationId:'flashback-scope-delete:' + plan.planId,
        assertTransactionCurrent:()=>repo.writerFence.verify(key,body.fence) });
      if (current.view.records.some(r => { const value = repo.get(r.space,r.key); return value.exists || !value.tombstone; })) fail('FLASHBACK_SCOPE_DELETE_READBACK_FAILED');
      onDeleted(plan.scopeKey);
      plan.receipt = { schema:'flashback.scope-delete-receipt.v1', ok:true, durable:true, verified:true,
        scopeKey:plan.scopeKey, dataInstanceId:plan.dataInstanceId, epoch:plan.epoch, deleted:mutations.length, backupId:saved.result.id };
      return { ...plan.receipt };
    } finally {
      busy = false;
    }
  };
};
