'use strict';

// Logical migration safety policy. This file never performs I/O; it only
// classifies stored owner values and strips transient execution authority that
// must not become live on a different server process.
const SOURCE_EDIT_SCHEMA = 'memory-suite.source-edit-consent.v1';
const HAYAKU_RECOVERY_VAULT_SCHEMA = 'hayaku.recovery_vault.v1';
const LIBRA_UNIFIED_TX_SCHEMA = 'libra.unified_state_tx.v1';

function objectish(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function hayakuShardHash(value) {
  const text=JSON.stringify(value);let hash=14695981039346656037n;
  for(let i=0;i<text.length;i++)hash=((hash^BigInt(text.charCodeAt(i)))*1099511628211n)&18446744073709551615n;
  return 'h64'+hash.toString(36);
}


function classifyRecord(namespace, row) {
  const out = { exportable: true, reason: '', parsed: null, authorityChanged: false };
  if (!row || Number(row.deleted) === 1 || row.value_json == null) return out;
  try { out.parsed = JSON.parse(String(row.value_json)); }
  catch (_) { return { ...out, exportable: false, reason: 'stored_json_invalid' }; }
  const value = out.parsed;
  if (namespace === 'libra' && objectish(value) && value.schema === LIBRA_UNIFIED_TX_SCHEMA
      && String(value.state || '').toLowerCase() === 'prepared') {
    return { ...out, exportable: false, reason: 'libra_unified_prepared_transaction_requires_repair' };
  }
  return out;
}

function validateOwnerRecord(namespace, row, parsed) {
  if (!['flashback','hayaku','libra','lia','retrace'].includes(String(namespace || ''))) return { ok:false, reason:'namespace_invalid' };
  if (!row || !['plugin','local'].includes(String(row.space || ''))) return { ok:false, reason:'space_invalid' };
  if (!String(row.key || '')) return { ok:false, reason:'key_missing' };
  const revision = Number(row.revision);
  if (!Number.isSafeInteger(revision) || revision < 0) return { ok:false, reason:'revision_invalid' };
  if (Number(row.deleted) !== 1 && parsed == null) return { ok:false, reason:'value_invalid' };
  if(namespace==='hayaku' && Number(row.deleted)!==1 && String(row.key).startsWith('hayaku.v2.recovery_vault.') && String(row.key).includes('::debt:')){
    let value=parsed;if(typeof value==='string'){try{value=JSON.parse(value);}catch(_){}}
    if(!objectish(value)||value.schema!==HAYAKU_RECOVERY_VAULT_SCHEMA||value.storagePart!=='debt'||!Array.isArray(value.records)||value.records.length!==1
      ||value.recordId!==value.records[0]?.recordId||value.scopeKey!==value.records[0]?.scopeKey
      ||!String(row.key).startsWith('hayaku.v2.recovery_vault.'+value.scopeKey+'::debt:')||value.payloadHash!==hayakuShardHash(value.records))return {ok:false,reason:'hayaku_recovery_shard_invalid'};
  }
  return { ok:true };
}

function clearAuthority(namespace, value) {
  // pluginStorage's JSON string lives inside the server JSON value envelope.
  if(namespace==='hayaku' && typeof value==='string'){
    let inner;try{inner=JSON.parse(value);}catch(_){}
    if(objectish(inner)&&inner.schema===HAYAKU_RECOVERY_VAULT_SCHEMA){const out=clearAuthority(namespace,inner);return {...out,value:out.changed?JSON.stringify(out.value):value};}
  }
  if (!objectish(value)) return { value, changed:false, notes:[] };
  const next = clone(value), notes = [];
  if (next.schema === SOURCE_EDIT_SCHEMA && objectish(next.tasks)) {
    for (const task of Object.values(next.tasks)) {
      if (!objectish(task)) continue;
      if (['approved','running'].includes(String(task.state || ''))) {
        task.state = 'interrupted';
        task.error = '서버 이관 후 재분석 동의가 필요합니다.';
        task.approvedAt = 0;
        task.updatedAt = Date.now();
        notes.push('source_edit_authority_cleared');
      }
    }
  }
  if (namespace === 'hayaku' && next.schema === HAYAKU_RECOVERY_VAULT_SCHEMA && Array.isArray(next.records)) {
    for (const record of next.records) {
      if (!objectish(record)) continue;
      if (record.repairLease) {
        record.repairLease = null;
        if (String(record.status || '') === 'repair_pending') record.status = 'deterministic_fallback';
        notes.push('hayaku_repair_lease_cleared');
      }
      if (String(record.backgroundDecision || '') === 'approved') {
        record.backgroundDecision = 'pending';
        record.backgroundDecisionAt = 0;
        notes.push('hayaku_background_approval_cleared');
      }
    }
  }
  if(namespace==='hayaku'&&next.schema===HAYAKU_RECOVERY_VAULT_SCHEMA&&next.storagePart==='debt'&&notes.length)next.payloadHash=hayakuShardHash(next.records);
  return { value: next, changed: notes.length > 0, notes };
}

function finishGraph(summary = {}) {
  return {
    schema: 'librarian.migration-graph-check.v1',
    namespaces: Number(summary.namespaces || 0),
    records: Number(summary.records || 0),
    tombstones: Number(summary.tombstones || 0),
    authorityClears: Number(summary.authorityClears || 0),
    blockers: Array.isArray(summary.blockers) ? summary.blockers.slice(0, 100) : []
  };
}

module.exports = {
  SOURCE_EDIT_SCHEMA,
  HAYAKU_RECOVERY_VAULT_SCHEMA,
  LIBRA_UNIFIED_TX_SCHEMA,
  classifyRecord,
  validateOwnerRecord,
  clearAuthority,
  finishGraph
};
