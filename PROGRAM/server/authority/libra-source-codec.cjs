'use strict';
// Fixed value-only LIBRA codec. Legacy digest validates stored schema identities;
// cryptographic source/body SHA256 is independently supplied by the observer.
// Pure validator bodies below are pinned copies of the current production plugin.
const C=require('./contracts.cjs'),J=require('./observation-json.cjs');
const asObject=v=>v&&typeof v==='object'&&!Array.isArray(v)?v:{};
const asArray=v=>Array.isArray(v)?v:[];
const string=v=>String(v??'').trim();
const clone=v=>structuredClone(v);
const isPlainObject=v=>!!v&&typeof v==='object'&&!Array.isArray(v)&&(Object.getPrototypeOf(v)===Object.prototype||Object.getPrototypeOf(v)===null);
const digest=value=>{const h=createTextHasher();h.update(typeof value==='string'?value:JSON.stringify(value??null));return h.digest();};
const canonicalEvidenceComparable=value=>string(value||'').normalize('NFKC').replace(/\r\n?/g,'\n').replace(/\s+/g,' ').trim();
const STATE_PIPELINE_DOMAINS=Object.freeze(['character','relationship','world','narrative']);
const STATE_PIPELINE_FORBIDDEN_FIELDS=new Set(['__proto__','prototype','constructor','history','events','timeline','revisions','previous','inner_thoughts','innerThoughts','affinity_score','turningPoints','resolvedThreads','archive','motifCounts','nextScenePlan','next_scene_plan']);
const statePipelineRiskFieldKey=value=>string(value||'').normalize('NFKC').toLowerCase().replace(/[\s_.\-:·/\\]+/g,'').trim();
const PREFIX='libra:v1';
const prefix=s=>`${PREFIX}:scope:${s.scopeKey}:`;
const base=(w,e,t)=>`${w}:e${e}:t${t}`;
const key=Object.freeze({
 completedTurnReceipt:(s,w,e,t,r)=>prefix(s)+'source-receipt:'+base(w,e,t)+':'+r,
 completedTurnHead:(s,w,e,t)=>prefix(s)+'source-receipt-head:'+base(w,e,t),
 completedTurnCapture:(s,w,e,t,r)=>prefix(s)+'source-receipt-capture:'+base(w,e,t)+':'+r,
 personSpanInventory:(s,w,e,t,r,i)=>prefix(s)+'person-span-inventory:'+base(w,e,t)+':'+r+':'+i,
 personSpanInventoryHead:(s,w,e,t)=>prefix(s)+'person-span-inventory-head:'+base(w,e,t),
 microWork:(s,w,e,t,r,p)=>prefix(s)+'micro-work:'+base(w,e,t)+':'+r+':'+p,
 microMemory:(s,w,e,t,r,a)=>prefix(s)+'micro-memory:'+base(w,e,t)+':'+r+':'+a,
 microMemoryHead:(s,w,e,t)=>prefix(s)+'micro-memory-head:'+base(w,e,t),
 microStateAdmission:(s,w,e,t,r,a,i,b)=>prefix(s)+'micro-state-admission:'+base(w,e,t)+':'+r+':'+a+':c'+i+':'+b
});
function requireFact(ok){if(!ok)C.fail('SOURCE_PROOF_UNAVAILABLE');}
function requiredString(v){J.unicode(v);requireFact(v.length>0&&v.length<=4096&&v===v.trim());return v;}
function integer(v,min=0){requireFact(Number.isSafeInteger(v)&&v>=min);return v;}
function receipt(r,sourceKey){J.plain(r);requireFact(r.schema==='libra.completed_turn_receipt.v1');for(const f of ['scopeKey','worldlineId','revisionId','sourceDigest'])requiredString(r[f]);integer(r.sessionEpoch);integer(r.turn,1);
 for(const role of ['user','assistant']){const row=J.plain(r[role]);requiredString(row.chatId);requireFact(typeof row.text==='string'&&row.text===row.text.trim());for(const a of ['chatIds','rawPayloadDigests','sanitizedTextDigests'])requireFact(Array.isArray(row[a]));}
 requireFact(key.completedTurnReceipt(r,r.worldlineId,r.sessionEpoch,r.turn,r.revisionId)===sourceKey&&completedTurnRevisionId(r)===r.revisionId&&sourceDigest([r])===r.sourceDigest);return r;
}
function microRecallMemoryFromRecord(recordValue,receiptValue,recordKey){
 const record=J.plain(recordValue),r=receipt(receiptValue,record.receiptKey),body={...record};delete body.analysisRevisionId;
 requireFact(record.schema==='libra.micro_memory.v1'&&record.analysisRevisionId===digest(body)&&record.scopeKey===r.scopeKey&&record.worldlineId===r.worldlineId&&record.sessionEpoch===r.sessionEpoch&&record.turn===r.turn&&record.sourceRevisionId===r.revisionId&&record.sourceDigest===r.sourceDigest);
 requireFact(recordKey===key.microMemory(r,r.worldlineId,r.sessionEpoch,r.turn,r.revisionId,record.analysisRevisionId));
 let claims=[];const excerpt=asObject(record.excerpt);
 if(record.analysisStatus==='verified'){
  const v=validateMicroCandidate({schema:record.schema,scopeKey:record.scopeKey,worldlineId:record.worldlineId,sessionEpoch:record.sessionEpoch,turn:record.turn,sourceRevisionId:record.sourceRevisionId,sourceDigest:record.sourceDigest,claims:record.claims},r);
  requireFact(v.claims.length>0&&v.claims.length===asArray(record.claims).length);claims=v.claims;
  // The fixed SQL projection is byte-exact for the canonical stored form. Do not
  // silently trim an alternate stored representation after admission.
  requireFact(record.claims.every((c,i)=>c.text===claims[i].text&&c.actor===claims[i].actor&&c.target===claims[i].target));
 }else{
  requireFact(record.analysisStatus==='minimum_source_bound'&&Array.isArray(record.claims)&&record.claims.length===0);
  const row=r[excerpt.role];requireFact(['user','assistant'].includes(excerpt.role)&&row&&excerpt.messageId===row.chatId&&Number.isSafeInteger(excerpt.startOffset)&&Number.isSafeInteger(excerpt.endOffset)&&excerpt.startOffset>=0&&excerpt.endOffset>excerpt.startOffset&&excerpt.endOffset<=row.text.length&&typeof excerpt.exactQuote==='string'&&row.text.slice(excerpt.startOffset,excerpt.endOffset)===excerpt.exactQuote);
 }
 const detail=claims.length?claims.map((c,i)=>`[변화 ${i+1} · ${c.evidence.role} · ${c.evidence.messageId}] ${c.text}\n근거: ${c.evidence.exactQuote}`).join('\n'):`[원문 발췌 · ${excerpt.role} · ${excerpt.messageId}] ${excerpt.exactQuote}`;
 return {profile:claims.length?'libra.micro.claims-text.v1':'libra.micro.source-span.v1',text:`[MICRO T${record.turn} · 단일 턴 근거]\n${detail}`,sourceSpans:claims.length?claims.map(c=>c.evidence):[excerpt]};
}
const createTextHasher = () => {
    let hash = 2166136261;
    let length = 0;
    return {
      update(value) {
        const body = String(value ?? '');
        for (let idx = 0; idx < body.length; idx += 1) {
          hash ^= body.charCodeAt(idx);
          hash = Math.imul(hash, 16777619);
        }
        hash ^= 31;
        hash = Math.imul(hash, 16777619);
        length += body.length + 1;
        return this;
      },
      digest() { return `${(hash >>> 0).toString(16).padStart(8, '0')}:${length}`; }
    };
  };

  
const sourceDigest = batch => digest(batch.map(pair => ({
      turn: pair.turn,
      userChatId: pair.user.chatId,
      assistantChatId: pair.assistant.chatId,
      user: pair.user.text,
      assistant: pair.assistant.text
    })));
    const completedTurnRevisionId = pair => digest({
      turn: Number(pair?.turn || 0),
      user: {
        chatIds: asArray(pair?.user?.chatIds), text: string(pair?.user?.text || ''),
        rawPayloadDigests: asArray(pair?.user?.rawPayloadDigests), sanitizedTextDigests: asArray(pair?.user?.sanitizedTextDigests)
      },
      assistant: {
        chatIds: asArray(pair?.assistant?.chatIds), text: string(pair?.assistant?.text || ''),
        rawPayloadDigests: asArray(pair?.assistant?.rawPayloadDigests), sanitizedTextDigests: asArray(pair?.assistant?.sanitizedTextDigests)
      }
    }).replace(/[^a-z0-9]/gi, '');
    
const hostWorldlineIdForScope = scope => {
      const parts = [string(scope?.characterId || ''), string(scope?.chatId || ''), string(scope?.scopeKey || '')];
      const left = digest(['host-worldline-a', ...parts]).split(':')[0];
      const right = digest(['host-worldline-b', ...parts]).split(':')[0];
      return `wl_${left}${right}`;
    };
    
const canonicalEntityWordChar = ch => !!ch && /[\p{L}\p{N}_]/u.test(ch);
    const CANONICAL_ENTITY_KOREAN_PARTICLE = /^(?:에게서는|에게서|에게는|에게|한테서는|한테서|한테는|한테|께서는|께서|께|으로서는|으로서|로서는|로서|으로써|로써|으로는|으로|에서는|에서|부터|까지|처럼|하고|이며|이랑|랑|들은|들이|들을|들의|들과|들|은|는|이|가|을|를|의|도|와|과|로|만|에)(?=$|[^\p{L}\p{N}_])/u;
    const canonicalEntityNameBoundToEvidence = (name, quote) => {
      const needle = canonicalEvidenceComparable(name);
      const source = canonicalEvidenceComparable(quote);
      if (!needle || !source) return false;
      let from = 0;
      while (from < source.length) {
        const at = source.indexOf(needle, from);
        if (at < 0) return false;
        from = at + needle.length;
        if (canonicalEntityWordChar(source[at - 1])) continue;
        const tail = source.slice(from);
        if (!canonicalEntityWordChar(tail[0]) || CANONICAL_ENTITY_KOREAN_PARTICLE.test(tail)) return true;
      }
      return false;
    };
    
const validateMicroCandidate = (candidateValue, receiptValue) => {
      const candidate = asObject(candidateValue), receipt = asObject(receiptValue);
      const rejectedResult = reason => ({ schema: 'libra.micro_candidate_validation.v1',
        status: 'rejected', authority: 'none', claims: [], rejected: [{ index: -1, reason }] });
      const candidateFields = new Set(['schema', 'scopeKey', 'worldlineId', 'sessionEpoch', 'turn',
        'sourceRevisionId', 'sourceDigest', 'label', 'claims']);
      if (candidate.schema !== 'libra.micro_memory.v1' || receipt.schema !== 'libra.completed_turn_receipt.v1'
        || Object.keys(candidate).some(field => !candidateFields.has(field))) return rejectedResult('schema_or_field_invalid');
      if (!string(receipt.scopeKey) || candidate.scopeKey !== receipt.scopeKey
        || candidate.worldlineId !== receipt.worldlineId
        || Number(candidate.sessionEpoch) !== Number(receipt.sessionEpoch)
        || Number(candidate.turn) !== Number(receipt.turn)
        || candidate.sourceRevisionId !== receipt.revisionId
        || candidate.sourceDigest !== receipt.sourceDigest) return rejectedResult('receipt_binding_invalid');
      if (typeof candidate.label !== 'undefined'
        && (typeof candidate.label !== 'string' || candidate.label.length > 120)) return rejectedResult('label_invalid');
      if (!Array.isArray(candidate.claims) || !candidate.claims.length || candidate.claims.length > 16) {
        return rejectedResult('claim_count_invalid');
      }
      const claimFields = new Set(['changeKind', 'text', 'actor', 'target', 'temporalRole',
        'certainty', 'epistemicStatus', 'stateChangeType', 'stateIntent', 'evidence']);
      const evidenceFields = new Set(['role', 'messageId', 'startOffset', 'endOffset', 'exactQuote']);
      const forbiddenStateIntentFields = new Set([...STATE_PIPELINE_FORBIDDEN_FIELDS].map(statePipelineRiskFieldKey));
      const stateIntentValueValid = (value, depth = 0) => {
        if (depth > 8) return false;
        if (typeof value === 'string') return value.length <= 800;
        if (typeof value === 'boolean') return true;
        if (typeof value === 'number') return Number.isFinite(value);
        if (Array.isArray(value)) return value.length <= 32
          && value.every(item => stateIntentValueValid(item, depth + 1));
        return isPlainObject(value) && Object.keys(value).length <= 32
          && Object.entries(value).every(([field, item]) => !forbiddenStateIntentFields.has(statePipelineRiskFieldKey(field))
            && stateIntentValueValid(item, depth + 1));
      };
      const stateIntentReason = (intentValue, claim, quote) => {
        const intent = asObject(intentValue), target = asObject(intent.target);
        const domain = string(intent.domain || ''), operation = string(intent.operation || '');
        if (!isPlainObject(intentValue) || Object.keys(intent).some(field =>
          !['domain', 'target', 'field', 'operation', 'value'].includes(field))
          || !isPlainObject(intent.target) || !STATE_PIPELINE_DOMAINS.includes(domain)
          || !['set', 'clear'].includes(operation) || operation !== claim.stateChangeType
          || typeof intent.field !== 'string' || !intent.field.trim() || intent.field.length > 120
          || forbiddenStateIntentFields.has(statePipelineRiskFieldKey(intent.field))) return 'state_intent_contract_invalid';
        if (operation === 'set' ? !Object.prototype.hasOwnProperty.call(intent, 'value')
          || !stateIntentValueValid(intent.value) || JSON.stringify(intent.value).length > 1200
          : Object.prototype.hasOwnProperty.call(intent, 'value')) return 'state_intent_value_invalid';
        if (domain === 'character' || domain === 'world') {
          if (Object.keys(target).length !== 1 || typeof target.entityName !== 'string'
            || !target.entityName.trim() || target.entityName.length > 120
            || !canonicalEntityNameBoundToEvidence(target.entityName, quote)) return 'state_intent_target_unbound';
        } else if (domain === 'relationship') {
          if (Object.keys(target).length !== 3 || typeof target.subjectName !== 'string'
            || typeof target.targetName !== 'string' || typeof target.dimension !== 'string'
            || !target.subjectName.trim() || !target.targetName.trim()
            || !target.dimension.trim() || target.dimension.length > 80
            || !canonicalEntityNameBoundToEvidence(target.subjectName, quote)
            || !canonicalEntityNameBoundToEvidence(target.targetName, quote)) return 'state_intent_target_unbound';
        } else if (Object.keys(target).length !== 1 || target.scope !== 'current_narrative') {
          return 'state_intent_target_invalid';
        }
        return '';
      };
      const claims = [], rejected = [];
      for (const [index, source] of candidate.claims.entries()) {
        const claim = asObject(source), evidence = asObject(claim.evidence);
        const row = asObject(receipt[evidence.role]);
        const startOffset = Number(evidence.startOffset), endOffset = Number(evidence.endOffset);
        let reason = '';
        if (!isPlainObject(source) || Object.keys(claim).some(field => !claimFields.has(field))
          || !isPlainObject(claim.evidence) || Object.keys(evidence).some(field => !evidenceFields.has(field))) reason = 'claim_field_invalid';
        else if (!['event', 'person', 'relation', 'world', 'thread', 'correction'].includes(claim.changeKind)
          || typeof claim.text !== 'string' || !claim.text.trim() || claim.text.length > 360
          || typeof claim.actor !== 'string' || claim.actor.length > 120
          || typeof claim.target !== 'string' || claim.target.length > 120
          || (claim.changeKind === 'relation' && (!claim.actor.trim() || !claim.target.trim()))
          || !['current', 'historical', 'hypothetical', 'uncertain'].includes(claim.temporalRole)
          || !['confirmed', 'uncertain'].includes(claim.certainty)
          || !['observed', 'reported', 'uncertain'].includes(claim.epistemicStatus)
          || !['none', 'set', 'clear'].includes(claim.stateChangeType)) reason = 'claim_contract_invalid';
        else if (!['user', 'assistant'].includes(evidence.role)
          || typeof evidence.messageId !== 'string' || evidence.messageId !== string(row.chatId || '')
          || !Number.isInteger(startOffset) || !Number.isInteger(endOffset)
          || startOffset < 0 || endOffset <= startOffset || endOffset > string(row.text || '').length
          || typeof evidence.exactQuote !== 'string' || !evidence.exactQuote.trim()
          || evidence.exactQuote.length > 600
          || string(row.text || '').slice(startOffset, endOffset) !== evidence.exactQuote) reason = 'evidence_span_invalid';
        else if ((claim.actor.trim() && !canonicalEntityNameBoundToEvidence(claim.actor, evidence.exactQuote))
          || (claim.target.trim() && !canonicalEntityNameBoundToEvidence(claim.target, evidence.exactQuote))) reason = 'participant_unbound';
        else if (claim.stateChangeType !== 'none'
          && (claim.temporalRole !== 'current' || claim.certainty !== 'confirmed'
            || claim.epistemicStatus !== 'observed')) reason = 'state_change_authority_invalid';
        else if (Object.prototype.hasOwnProperty.call(claim, 'stateIntent')) {
          reason = stateIntentReason(claim.stateIntent, claim, evidence.exactQuote);
        }
        if (reason) { rejected.push({ index, reason }); continue; }
        claims.push({ changeKind: claim.changeKind, text: claim.text.trim(), actor: claim.actor.trim(),
          target: claim.target.trim(), temporalRole: claim.temporalRole, certainty: claim.certainty,
          epistemicStatus: claim.epistemicStatus, stateChangeType: claim.stateChangeType,
          ...(claim.stateIntent ? { stateIntent: clone(claim.stateIntent) } : {}),
          evidence: { role: evidence.role, messageId: evidence.messageId, startOffset, endOffset,
            exactQuote: evidence.exactQuote } });
      }
      return { schema: 'libra.micro_candidate_validation.v1',
        status: claims.length ? 'source_bound_candidate' : 'rejected',
        authority: claims.length ? 'candidate_only' : 'none',
        sourceRevisionId: string(receipt.revisionId || ''), sourceDigest: string(receipt.sourceDigest || ''),
        claims, rejected };
    };
    
const MICRO_HANDOFF_OWNER_KINDS = Object.freeze([
      'source-receipt', 'source-receipt-head', 'source-receipt-capture',
      'person-span-inventory', 'person-span-inventory-head', 'micro-work',
      'micro-memory', 'micro-memory-head', 'micro-state-admission'
    ]);
    const MICRO_HANDOFF_OWNER_SCHEMAS = Object.freeze({
      'source-receipt': 'libra.completed_turn_receipt.v1',
      'source-receipt-head': 'libra.completed_turn_head.v1',
      'source-receipt-capture': 'libra.completed_turn_capture.v1',
      'person-span-inventory': 'libra.person_span_inventory.v1',
      'person-span-inventory-head': 'libra.person_span_inventory_head.v1',
      'micro-work': 'libra.micro_work.v1',
      'micro-memory': 'libra.micro_memory.v1',
      'micro-memory-head': 'libra.micro_memory_head.v1',
      'micro-state-admission': 'libra.micro_state_admission.v1'
    });
    const microWorkSupportsPublishedRecord = (workValue, recordValue) => {
      const work = asObject(workValue), record = asObject(recordValue);
      if (work.status === 'result_ready') {
        return !!work.result && work.resultDigest === digest(work.result);
      }
      if (record.analysisStatus !== 'minimum_source_bound'
        || work.status !== 'reserved'
         || !['retry_planned', 'manual_planned', 'invoking'].includes(work.phase)
        || work.result || !asArray(work.priorResults).length) return false;
      return asArray(work.priorResults).some(prior => {
        const result = asObject(prior?.result);
        const minimum = asObject(result.minimumSourceBound);
        return !!prior?.result && prior.resultDigest === digest(prior.result)
          && Number.isInteger(Number(prior.logicalAttempts))
          && Number(prior.logicalAttempts) > 0
          && Number(prior.logicalAttempts) < Number(work.logicalAttempts)
          && minimum.schema === 'libra.micro_memory.v1'
          && minimum.analysisStatus === 'minimum_source_bound'
          && minimum.scopeKey === record.scopeKey
          && minimum.worldlineId === record.worldlineId
          && Number(minimum.sessionEpoch) === Number(record.sessionEpoch)
          && Number(minimum.turn) === Number(record.turn)
          && minimum.sourceRevisionId === record.sourceRevisionId
          && minimum.sourceDigest === record.sourceDigest
          && !asArray(minimum.claims).length
          && digest(minimum.excerpt) === digest(record.excerpt);
      });
    };
    const validateMicroHandoffArchive = (archiveValue, ref = null) => {
      const archive = asObject(archiveValue);
      const sourceScopeKey = string(archive.sourceScopeKey || '');
      const activeWorldlineId = string(archive.activeWorldlineId || '');
      const scopePrefix = `${PREFIX}:scope:${sourceScopeKey}:`;
      const rows = asArray(archive.records);
      const byKey = new Map();
      if (archive.schema !== 'libra.micro_handoff_archive.v1' || !sourceScopeKey
        || !activeWorldlineId
        || !Number.isInteger(Number(archive.recordCount))
        || Number(archive.recordCount) !== rows.length
        || ref && (ref.schema !== 'libra.micro_handoff_archive_ref.v1'
          || ref.sourceScopeKey !== sourceScopeKey
          || ref.archiveDigest !== archive.archiveDigest
          || Number(ref.recordCount) !== rows.length)) {
        throw new Error('LIBRA_MICRO_HANDOFF_ARCHIVE_IDENTITY_INVALID');
      }
      for (const row of rows) {
        const storageKey = string(row?.key || '');
        const kind = MICRO_HANDOFF_OWNER_KINDS.find(name =>
          storageKey.startsWith(`${scopePrefix}${name}:`));
        if (!kind || byKey.has(storageKey) || !row?.value
          || row.value.schema !== MICRO_HANDOFF_OWNER_SCHEMAS[kind]
          || row.value.scopeKey !== sourceScopeKey || storageKey.includes('::chunk:')) {
          throw new Error('LIBRA_MICRO_HANDOFF_ARCHIVE_RECORD_INVALID');
        }
        byKey.set(storageKey, row.value);
      }
      const recordsDigest = digest(rows.map(row => ({key: row.key,
        valueDigest: digest(row.value)})).sort((a, b) => a.key.localeCompare(b.key)));
      const core = {schema: archive.schema, sourceScopeKey, activeWorldlineId,
        recordCount: rows.length, recordsDigest, records: rows};
      if (archive.recordsDigest !== recordsDigest
        || archive.archiveDigest !== digest(core)) {
        throw new Error('LIBRA_MICRO_HANDOFF_ARCHIVE_DIGEST_INVALID');
      }
      for (const row of rows) {
        const value = row.value;
        if (value.schema === 'libra.completed_turn_receipt.v1') {
          if (row.key !== key.completedTurnReceipt({scopeKey: sourceScopeKey},
            value.worldlineId, value.sessionEpoch, value.turn, value.revisionId)
            || completedTurnRevisionId(value) !== value.revisionId
            || sourceDigest([value]) !== value.sourceDigest) {
            throw new Error('LIBRA_MICRO_HANDOFF_RECEIPT_INVALID');
          }
        } else if (value.schema === 'libra.completed_turn_head.v1') {
          const receipt = byKey.get(value.receiptKey);
          if (row.key !== key.completedTurnHead({scopeKey: sourceScopeKey},
            value.worldlineId, value.sessionEpoch, value.turn)
            || receipt?.schema !== 'libra.completed_turn_receipt.v1'
            || receipt.revisionId !== value.revisionId
            || receipt.sourceDigest !== value.sourceDigest) {
            throw new Error('LIBRA_MICRO_HANDOFF_RECEIPT_HEAD_INVALID');
          }
        } else if (value.schema === 'libra.completed_turn_capture.v1') {
          const receipt = byKey.get(value.receiptKey);
          if (row.key !== key.completedTurnCapture({scopeKey: sourceScopeKey},
            value.worldlineId, value.sessionEpoch, value.turn, value.revisionId)
            || receipt?.schema !== 'libra.completed_turn_receipt.v1'
            || receipt.revisionId !== value.revisionId
            || receipt.sourceDigest !== value.sourceDigest) {
            throw new Error('LIBRA_MICRO_HANDOFF_CAPTURE_INVALID');
          }
        } else if (value.schema === 'libra.person_span_inventory.v1') {
          const receipt = byKey.get(value.receiptKey);
          const work = value.workKey ? byKey.get(value.workKey) : null;
          if (row.key !== key.personSpanInventory({scopeKey: sourceScopeKey},
            value.worldlineId, value.sessionEpoch, value.turn,
            value.revisionId, value.inventoryRevisionId)
            || receipt?.schema !== 'libra.completed_turn_receipt.v1'
            || receipt.revisionId !== value.revisionId
            || receipt.sourceDigest !== value.sourceDigest
            || !['known_mentions_only', 'classified_candidates'].includes(value.status)
            || value.status === 'classified_candidates'
              && (work?.schema !== 'libra.micro_work.v1'
                || work.receiptKey !== value.receiptKey
                || work.resultDigest !== value.workResultDigest)) {
            throw new Error('LIBRA_MICRO_HANDOFF_INVENTORY_INVALID');
          }
        } else if (value.schema === 'libra.person_span_inventory_head.v1') {
          const inventory = byKey.get(value.inventoryKey);
          if (row.key !== key.personSpanInventoryHead({scopeKey: sourceScopeKey},
            value.worldlineId, value.sessionEpoch, value.turn)
            || inventory?.schema !== 'libra.person_span_inventory.v1'
            || inventory.revisionId !== value.receiptRevisionId
            || inventory.sourceDigest !== value.sourceDigest
            || inventory.registryDigest !== value.registryDigest
            || inventory.inventoryRevisionId !== value.inventoryRevisionId) {
            throw new Error('LIBRA_MICRO_HANDOFF_INVENTORY_HEAD_INVALID');
          }
        } else if (value.schema === 'libra.micro_work.v1') {
          const receipt = byKey.get(value.receiptKey);
          if (row.key !== key.microWork({scopeKey: sourceScopeKey},
            value.worldlineId, value.sessionEpoch, value.turn,
            value.sourceRevisionId, value.producerVersion)
            || receipt?.schema !== 'libra.completed_turn_receipt.v1'
            || receipt.revisionId !== value.sourceRevisionId
            || receipt.sourceDigest !== value.sourceDigest
            || value.result && value.resultDigest !== digest(value.result)
            || asArray(value.priorResults).some(prior => !prior?.result
              || prior.resultDigest !== digest(prior.result))) {
            throw new Error('LIBRA_MICRO_HANDOFF_WORK_INVALID');
          }
        } else if (value.schema === 'libra.micro_memory.v1') {
          const receipt = byKey.get(value.receiptKey);
          const work = byKey.get(value.workKey);
          if (row.key !== key.microMemory({scopeKey: sourceScopeKey},
            value.worldlineId, value.sessionEpoch, value.turn,
            value.sourceRevisionId, value.analysisRevisionId)
            || work?.schema !== 'libra.micro_work.v1'
            || work.receiptKey !== value.receiptKey
            || work.sourceRevisionId !== value.sourceRevisionId
            || work.sourceDigest !== value.sourceDigest
            || work.producerVersion !== value.producerVersion
            || !microWorkSupportsPublishedRecord(work, value)
            || !microRecallMemoryFromRecord(value, receipt, row.key)) {
            throw new Error('LIBRA_MICRO_HANDOFF_RECORD_INVALID');
          }
        } else if (value.schema === 'libra.micro_memory_head.v1') {
          const record = byKey.get(value.recordKey);
          if (row.key !== key.microMemoryHead({scopeKey: sourceScopeKey},
            value.worldlineId, value.sessionEpoch, value.turn)
            || record?.schema !== 'libra.micro_memory.v1'
            || record.sourceRevisionId !== value.sourceRevisionId
            || record.sourceDigest !== value.sourceDigest
            || record.analysisRevisionId !== value.analysisRevisionId) {
            throw new Error('LIBRA_MICRO_HANDOFF_HEAD_INVALID');
          }
        } else if (value.schema === 'libra.micro_state_admission.v1') {
          const record = byKey.get(value.microRecordKey);
          const decisionBody = clone(value);
          delete decisionBody.decisionDigest;
          if (record?.schema !== 'libra.micro_memory.v1'
            || row.key !== key.microStateAdmission({scopeKey: sourceScopeKey},
              value.worldlineId, value.sessionEpoch, value.turn,
              value.sourceRevisionId, value.analysisRevisionId,
              value.claimIndex, value.basisDigest)
            || record.sourceRevisionId !== value.sourceRevisionId
            || record.sourceDigest !== value.sourceDigest
            || record.analysisRevisionId !== value.analysisRevisionId
            || value.decisionDigest !== digest(decisionBody)
            || value.claimDigest !== digest(asArray(record.claims)[Number(value.claimIndex)])) {
            throw new Error('LIBRA_MICRO_HANDOFF_DECISION_INVALID');
          }
        }
      }
      return {archive, byKey};
    };
    
const libraArchiveRecordPayload = ref => {
      const payload = {
        schema: 'libra.shared_archive_record.v2',
        key: string(ref?.key || ''), physicalScopeKey: string(ref?.physicalScopeKey || ''),
        memoryId: string(ref?.memoryId || ''), revision: Number(ref?.revision || 0),
        sourceDigest: string(ref?.sourceDigest || ''),
        artifactSchema: string(ref?.artifactSchema || ''), artifactDigest: string(ref?.artifactDigest || ''),
        worldlineId: string(ref?.worldlineId || 'main'), turnRange: clone(asObject(ref?.turnRange)),
        archiveId: string(ref?.archiveId || ''), archiveCanonicalId: string(ref?.archiveCanonicalId || ''),
        vectorKey: string(ref?.vectorKey || '')
      };
      if(unifiedArtifactSchemaReadable(ref?.artifactSchema)){payload.sourceEvidenceDigest=string(ref.sourceEvidenceDigest||'');payload.unifiedOriginDigest=string(ref.unifiedOriginDigest||'');}
      if (ref?.manualStateDispositionDigest || ref?.manualAuthorityHash) {
        payload.manualStateDispositionDigest = string(ref?.manualStateDispositionDigest || '');
        payload.manualAuthorityHash = string(ref?.manualAuthorityHash || '');
      }
      return payload;
    };
    const libraArchiveRecordDigest = ref => digest(libraArchiveRecordPayload(ref));
    const libraArchiveRefsDigest = (refs, integrityVersion = 1) => {
      if (Number(integrityVersion || 1) < 2) return digest(asArray(refs).map(ref => ({
        archiveCanonicalId: string(ref.archiveCanonicalId || ''), key: string(ref.key || ''),
        revision: Number(ref.revision || 0), sourceDigest: string(ref.sourceDigest || ''), vectorKey: string(ref.vectorKey || '')
      })).sort((a, b) => a.archiveCanonicalId.localeCompare(b.archiveCanonicalId)));
      return digest({
        schema: 'libra.shared_archive_refs.v2', integrityVersion: 2,
        records: asArray(refs).map(ref => ({
          archiveCanonicalId: string(ref?.archiveCanonicalId || ''), key: string(ref?.key || ''),
          recordDigest: libraArchiveRecordDigest(ref)
        })).sort((a, b) => a.archiveCanonicalId.localeCompare(b.archiveCanonicalId) || a.key.localeCompare(b.key))
      });
    };

    
const unifiedArtifactSchemaReadable=value=>['libra.canonical_artifact.v4','libra.canonical_artifact.v5'].includes(string(value||''));
function checkedMicroArchive(value,ref){try{return validateMicroHandoffArchive(value,ref);}catch(error){if(error.code)throw error;C.fail('SOURCE_PROOF_UNAVAILABLE');}}
module.exports={digest,key,requiredString,integer,requireFact,receipt,microRecallMemoryFromRecord,hostWorldlineIdForScope,checkedMicroArchive,microWorkSupportsPublishedRecord,libraArchiveRecordDigest,libraArchiveRefsDigest,unifiedArtifactSchemaReadable};
