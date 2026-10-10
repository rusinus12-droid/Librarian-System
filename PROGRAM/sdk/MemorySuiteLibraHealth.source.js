/* LIBRA READ-ONLY SCOPE HEALTH v1.0.0 */
const inspectLibraScopeHealthSnapshot = (snapshot, options = {}) => {
  if(snapshot?.schema!=='libra.scope-health-snapshot.v1'||snapshot.readOnly!==true||!Array.isArray(snapshot.records)||!Array.isArray(snapshot.values))throw Error('LIBRA_SCOPE_HEALTH_SNAPSHOT_INVALID');
  const issues=[], entries=new Map(), live=new Set(), issue=(code,detail='')=>issues.push({code,detail});
  for(const r of snapshot.records)if(!r.tombstone&&r.space==='plugin'){live.add(r.name);}
  for(const r of snapshot.values){
    if(r.space!=='plugin')continue; // Local duplicates remain observable, never elected as canonical.
    let value=r.value;try{if(typeof value==='string')value=JSON.parse(value);if(!value||typeof value!=='object'||Array.isArray(value))throw Error();entries.set(r.name,value);}catch(_){issue('STRUCTURAL_JSON_INVALID',r.name.split(':').slice(0,2).join(':'));}
  }
  const manifest=entries.get('manifest'),head=entries.get('continuity-state'),registry=entries.get('entity-registry:v2');
  const counts={serverRecords:snapshot.liveRecords,tombstones:snapshot.tombstones,canonicalRefs:0,missingCanonicalRefs:0,pendingState:0,pendingVectors:0,pendingReplay:0,receipts:0,replayErrors:0,correctionRecords:0};
  if(manifest){const refs=manifest.memories;if(!refs||typeof refs!=='object')issue('MANIFEST_REF_STRUCTURE_INVALID');else for(const ref of Object.values(refs)){
    counts.canonicalRefs++;if(typeof ref?.key!=='string'){counts.missingCanonicalRefs++;continue;}const prefix='libra:v1:scope:'+snapshot.scopeKey+':';
    if(!ref.key.startsWith(prefix)){issue('CANONICAL_REF_SCOPE_MISMATCH');counts.missingCanonicalRefs++;}
    else if(snapshot.inventoryComplete&&!live.has(ref.key.slice(prefix.length)))counts.missingCanonicalRefs++;
  }}else if(snapshot.liveRecords>0)issue('MANIFEST_NOT_OBSERVED','없음 또는 검사 상한으로 미확인');
  if(counts.missingCanonicalRefs)issue('CANONICAL_REF_NOT_PRESENT',String(counts.missingCanonicalRefs));
  for(const [name,value] of entries){
    if(value.schema==='libra.unified_state_tx.v1'&&value.state==='prepared')counts.pendingState++;
    if(value.schema==='libra.unified_server_vector_tx.v1')counts.pendingVectors++;
    if(name.includes(':unified-replay-tx:'))counts.pendingReplay++;
    if(name.startsWith('state-pipeline-receipt:'))counts.receipts++;
    if(name==='state-replay-errors:v1')counts.replayErrors=Array.isArray(value.errors)?value.errors.length:Array.isArray(value.entries)?value.entries.length:0;
    if(name==='state-corrections:v2')counts.correctionRecords=Array.isArray(value.corrections)?value.corrections.length:Array.isArray(value.entries)?value.entries.length:0;
  }
  if(counts.pendingState)issue('PREPARED_STATE_TRANSACTION',String(counts.pendingState));
  if(counts.pendingReplay)issue('PENDING_REPLAY_TRANSACTION',String(counts.pendingReplay));
  if(counts.pendingVectors)issue('PENDING_VECTOR_TRANSACTION',String(counts.pendingVectors));
  if(counts.replayErrors)issue('REPLAY_ERRORS_RECORDED',String(counts.replayErrors));
  if(head&&!registry)issue('REGISTRY_NOT_OBSERVED');if(registry&&!head)issue('HEAD_NOT_OBSERVED');
  if(head&&registry&&head.entityRegistryFingerprint&&registry.fingerprint!==head.entityRegistryFingerprint)issue('HEAD_REGISTRY_FINGERPRINT_MISMATCH');
  if(snapshot.skipped?.length||!snapshot.complete)issue('INSPECTION_INCOMPLETE','검사 상한 또는 읽기 실패. 정상으로 확정하지 않습니다.');
  return {schema:'libra.scope-health-report.v1',at:snapshot.at,readOnly:true,scopeFingerprint:options.digest?options.digest(snapshot.scopeKey):snapshot.fingerprint,
    snapshotFingerprint:snapshot.fingerprint,complete:snapshot.complete===true,status:!snapshot.complete?'incomplete':issues.length?'attention':snapshot.liveRecords===0?'empty':'no_detected_issue',
    counts,throughTurn:Number(head?.throughTurn||0),issues,notChecked:['원문과 현재 채팅의 일치','모델 산출의 의미 정확도','전체 벡터 실체','과거 사용자 DATA 장애의 실제 원인'],
    recommendations:counts.pendingState?['기존 Pending State 재시도 기능을 명시적으로 실행한 뒤 다시 검사','재시도 실패 시 진단을 보존하고 현재 scope만 안전 초기화 검토']:['자료를 자동 변경하지 않았습니다. 오류가 있으면 진단을 보존하세요.']};
};
/* END LIBRA READ-ONLY SCOPE HEALTH */
