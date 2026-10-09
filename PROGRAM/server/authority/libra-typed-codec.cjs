'use strict';
// Fixed, value-only copies of the production v4/v5 validators and renderer.
// No runtime source extraction, eval, plugin load, writer, provider, or model.
// Source pins and exact segment readback live in the task checkpoint.
const V=require('./libra-source-codec.cjs');
const string=value=>typeof value==='string'?value:'';
const asObject=value=>value&&typeof value==='object'&&!Array.isArray(value)?value:{};
const asArray=value=>Array.isArray(value)?value:[];
const clone=value=>structuredClone(value);
const isPlainObject=value=>!!value&&typeof value==='object'&&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
const digest=V.digest,sourceDigest=batch=>digest(batch.map(pair=>({turn:pair.turn,userChatId:pair.user.chatId,assistantChatId:pair.assistant.chatId,user:pair.user.text,assistant:pair.assistant.text})));
const BATCH_SIZE=5;
const UNIFIED_ARTIFACT_SCHEMA='libra.canonical_artifact.v4',UNIFIED_ARTIFACT_SCHEMA_V5='libra.canonical_artifact.v5';
const unifiedArtifactSchemaReadable=value=>[UNIFIED_ARTIFACT_SCHEMA,UNIFIED_ARTIFACT_SCHEMA_V5].includes(value);
  const text = (value) => {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    try { return JSON.stringify(value); } catch (_) { return String(value); }
  };

  const compact = (value, max = 1000) => {
    const body = text(value).replace(/\r\n/g, '\n').replace(/[\t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    if (!max || body.length <= max) return body;
    return body.slice(0, Math.max(0, max - 24)).trimEnd() + '\n…[truncated]';
  };

  const CONTINUITY_STATE_RELATION_DIMENSIONS = Object.freeze([
    'trust', 'affection', 'attraction', 'fear', 'obligation', 'hostility', 'distance',
    'cooperation', 'authority', 'dependency', 'knowledge', 'other'
  ]);

    const CANONICAL_ARTIFACT_SCHEMA = 'libra.canonical_artifact.v3';
    const CANONICAL_ARTIFACT_LEGACY_SCHEMA = 'libra.canonical_artifact.v2';
    const CANONICAL_ARTIFACT_REFERENCE_MAX_CHARS = 16000;
    const CANONICAL_ARTIFACT_MAX_TEXT_CHARS = 30000;
    const CANONICAL_EVIDENCE_QUOTE_MAX_CHARS = 320;
    const CANONICAL_META_LEAK_PATTERN = /(?:<\/?think\b|let\s+me\s+(?:analy[sz]e|think)|(?:now|first|next)\s+(?:i(?:'ll|\s+will)|we(?:'ll|\s+will))|analysis\s*(?:commentary|notes?)|scratchpad|here(?:'s|\s+is)\s+the\s+(?:final|canonical)|i\s+need\s+to\s+(?:analy[sz]e|write|produce))/i;
    const canonicalEvidenceComparable = value => string(value || '').normalize('NFKC').replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim();
// Production evidence membership semantics; decorative stableHash fields are
// not used by validateUnifiedArtifact and are not manufactured in this adapter.
const canonicalEvidenceSources=batch=>new Map(batch.flatMap(pair=>[['u',pair.user.text],['a',pair.assistant.text]].map(([role,value])=>{const ref=`t${pair.turn}-${role}`;return [ref,{ref,comparable:canonicalEvidenceComparable(value)}];})));
const canonicalEvidenceSpanBinding=(span,source)=>{const comparable=canonicalEvidenceComparable(string(span?.quote||span?.text||'').trim());return !!source&&comparable.length>=2&&comparable.length<=CANONICAL_EVIDENCE_QUOTE_MAX_CHARS&&source.comparable.includes(comparable);};
    const canonicalLine = (label, value, evidenceRefs = []) => {
      const body = compact(string(value || '').replace(/\s+/g, ' '), 900);
      const evidence = asArray(evidenceRefs).map(item => string(item)).filter(Boolean).join(', ');
      return `- ${label ? `${label}: ` : ''}${body || '이번 배치에서 새로 확정된 내용 없음.'}${evidence ? ` (근거: ${evidence})` : ''}`;
    };
    const renderCanonicalArtifact = artifactValue => {
      const artifact = asObject(artifactValue);
      const chronology = asArray(artifact.chronology).map(item => canonicalLine('', item?.event || item?.text, item?.evidenceRefs));
      const characters = asArray(artifact.characters).map(item => canonicalLine(item?.name || item?.role || '인물', item?.fact || item?.state || item?.text, item?.evidenceRefs));
      const relationships = asArray(artifact.relationships).map(item => canonicalLine(`${item?.subject || '?'} → ${item?.target || '?'}${item?.dimension ? ` · ${item.dimension}` : ''}`, item?.state || item?.text, item?.evidenceRefs));
      const world = asArray(artifact.world).map(item => canonicalLine(item?.name || item?.kind || '세계', item?.state || item?.fact || item?.text, item?.evidenceRefs));
      const threads = asArray(artifact.openThreads).map(item => canonicalLine(item?.status || '미해결', item?.thread || item?.text, item?.evidenceRefs));
      const uncertainties = asArray(artifact.uncertainties).map(item => canonicalLine(item?.certainty || '불확실', item?.fact || item?.text, item?.evidenceRefs));
      const recall = asArray(artifact.recallTerms).map(item => compact(string(item), 120)).filter(Boolean);
      return [
        '# 종합 기억',
        '## 시간순 사건', ...(chronology.length ? chronology : ['- 이번 배치에서 확정된 사건 없음.']),
        '## 인물과 관계', ...((characters.length || relationships.length) ? [...characters, ...relationships] : ['- 이번 배치에서 새로 확정된 인물·관계 변화 없음.']),
        '## 세계와 장면', ...(world.length ? world : ['- 이번 배치에서 새로 확정된 세계 상태 변화 없음.']),
        '## 내러티브와 미해결 문제', ...(threads.length ? threads : ['- 이번 배치에서 새로 확정된 미해결 문제 없음.']),
        '## 확정 사실과 불확실 정보', ...(uncertainties.length ? uncertainties : ['- 별도로 표시할 불확실 정보 없음.']),
        '## 회상 키워드', `- ${recall.length ? recall.join(', ') : '해당 TURN 범위'}`
      ].join('\n');
    };
    const branchContentHash = value => {
      const body = String(value || '');
      let hashA = 2166136261;
      let hashB = 0x9e3779b9;
      for (let index = 0; index < body.length; index += 1) {
        const code = body.charCodeAt(index);
        hashA ^= code;
        hashA = Math.imul(hashA, 16777619);
        hashB ^= (code + index) >>> 0;
        hashB = Math.imul(hashB, 2246822519);
        hashB ^= hashB >>> 13;
      }
      return `${(hashA >>> 0).toString(16).padStart(8, '0')}${(hashB >>> 0).toString(16).padStart(8, '0')}:${body.length}`;
    };

    const sourcePairs = batch => batch.map(pair => ({ turn: pair.turn, userChatId: pair.user.chatId, assistantChatId: pair.assistant.chatId }));
    const UNIFIED_CLAIMS = Object.freeze({
      character_note: { domain: 'character', value: 'detail' },
      event: { domain: 'event', field: '', value: 'detail' },
      location: { domain: 'character', field: 'locationRef', value: 'locationRef', refType: 'world' },
      character_state: { domain: 'character', field: 'condition', value: 'condition' },
      character_appearance: { domain: 'character', field: 'appearance', value: 'appearance', collection: true, profile: true },
      character_background: { domain: 'character', field: 'background', value: 'background', collection: true, profile: true },
      character_personality: { domain: 'character', field: 'personality', value: 'personality', collection: true, profile: true },
      character_speech: { domain: 'character', field: 'speech', value: 'speech', collection: true, profile: true },
      character_habit: { domain: 'character', field: 'habits', value: 'habits', collection: true, profile: true },
      character_ability: { domain: 'character', field: 'abilities', value: 'abilities', collection: true, profile: true },
      character_goal: { domain: 'character', field: 'goal', value: 'goal' },
      knowledge: { domain: 'character', field: 'knowledge', value: 'knowledge', collection: true },
      affiliation: { domain: 'character', field: 'affiliations', value: 'affiliation' },
      scene_time: { domain: 'world', field: 'sceneTime', value: 'sceneTime' },
      relationship: { domain: 'relationship', field: 'value', value: 'value' },
      containment: { domain: 'world', field: 'parentRef', value: 'parentRef', refType: 'world' },
      management: { domain: 'world', field: 'managerRef', value: 'managerRef' },
      ownership: { domain: 'world', field: 'ownerRef', value: 'ownerRef' },
      possession: { domain: 'world', field: 'holderRef', value: 'holderRef', refType: 'person' },
      placement: { domain: 'world', field: 'containerRef', value: 'containerRef', refType: 'world' },
      access: { domain: 'world', field: 'access', value: 'access' },
      rule: { domain: 'world', field: 'rule', value: 'rule' },
      world_state: { domain: 'world', field: 'condition', value: 'condition' },
      thread: { domain: 'narrative', field: 'threads', value: 'thread' },
      // D03/T04: the v5 typed preference/boundary records. They are `collection`
      // because a character holds several and `effect:'remove'` must be able to
      // drop exactly one; `profile:true` puts them on the same Head projection the
      // other character-profile arrays use, so they inherit the existing
      // replay/correction path instead of getting a private ledger.
      character_preference: { domain: 'character', field: 'preferences', value: 'preferences', collection: true, profile: true },
      character_boundary: { domain: 'character', field: 'boundaries', value: 'boundaries', collection: true, profile: true }
    });
    // D02: v4 predates the World Maker claim kinds. They are valid only under
    // the explicitly dispatched v5 contract; existing v4 records keep the old
    // claim set and thread object shape.
    const UNIFIED_V4_CLAIMS = Object.freeze(Object.fromEntries(
      Object.entries(UNIFIED_CLAIMS).filter(([kind]) => !['character_preference','character_boundary'].includes(kind))));
    const unifiedClaimsForSchema = schema => schema === UNIFIED_ARTIFACT_SCHEMA_V5 ? UNIFIED_CLAIMS : UNIFIED_V4_CLAIMS;
    const UNIFIED_THREAD_LINK_KINDS = Object.freeze(['reaffirm','replace','resolve','reopen','associate']);
    // Why a thread closed. `fulfilled` and `broken` are deliberately different
    // reasons on the same `resolved` status: a broken promise must never read as
    // a successful fulfilment (`01` section 9, `03` A13).
    const UNIFIED_THREAD_RESOLUTION_REASONS = Object.freeze(['fulfilled','broken','cancelled','superseded','completed','withdrawn']);
    const unifiedAssert = (condition, code) => { if (!condition) { const e = new Error(code); e.code = code.split(':')[0]; throw e; } };
    const unifiedKeys = (obj, allowed, label) => {
      unifiedAssert(isPlainObject(obj), `UNIFIED_OBJECT_REQUIRED:${label}`);
      for (const k of Object.keys(obj)) unifiedAssert(allowed.includes(k), `UNIFIED_UNKNOWN_FIELD:${label}.${k}`);
    };
    const unifiedText = (value, max = 2000) => typeof value === 'string' && !!value.trim() && value.length <= max && !CANONICAL_META_LEAK_PATTERN.test(value);
    const unifiedId = value => typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(value);
    const unifiedDigestString = value => typeof value==='string'&&/^[a-f0-9]{8}:\d+$/i.test(value);
    const unifiedEvidence = (spans, sources, label) => {
      unifiedAssert(Array.isArray(spans) && spans.length > 0 && spans.length <= 10, `UNIFIED_EVIDENCE_REQUIRED:${label}`);
      for (const span of spans) {
        unifiedKeys(span, ['ref','quote'], label);
        unifiedAssert(!!canonicalEvidenceSpanBinding(span, sources.get(span.ref)), `UNIFIED_EVIDENCE_MISMATCH:${label}`);
      }
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
    const validateUnifiedEntityRecord = (e,entities,sources) => {
      unifiedKeys(e, ['tempId','name','type','kind','evidenceSpans'], 'entity');
      unifiedAssert(unifiedId(e.tempId) && !entities.has(e.tempId), 'UNIFIED_ENTITY_ID_INVALID');
      unifiedAssert(unifiedText(e.name, 180) && ['person','world'].includes(e.type), 'UNIFIED_ENTITY_INVALID');
      unifiedAssert(e.type === 'person' ? (!e.kind || e.kind === 'person') : ['location','object','organization','rule','environment','condition','thread','other'].includes(e.kind), 'UNIFIED_ENTITY_KIND_INVALID');
      unifiedEvidence(e.evidenceSpans, sources, e.tempId);
      unifiedAssert(e.evidenceSpans.some(s => e.type === 'person'
        ? canonicalEntityNameBoundToEvidence(e.name, s.quote)
        : canonicalEvidenceComparable(s.quote).includes(canonicalEvidenceComparable(e.name))), 'UNIFIED_ENTITY_NAME_UNBOUND');
    };
    const validateUnifiedFactRecord = (f,entities,facts,sources,schema=UNIFIED_ARTIFACT_SCHEMA,allowCandidateAlias=false,allowLegacyProfileStrings=false) => {
      unifiedKeys(f, ['tempFactId','domain','subjectTempRef','targetTempRef','dimension','claimKind','values','text','temporalRole','certainty','evidenceSpans','dependsOn','effect'], 'fact');
      unifiedAssert(unifiedId(f.tempFactId) && !facts.has(f.tempFactId), 'UNIFIED_FACT_ID_INVALID');
      const contract = unifiedClaimsForSchema(schema)[f.claimKind];
      unifiedAssert(contract && contract.domain === f.domain, 'UNIFIED_FACT_KIND_INVALID');
      unifiedAssert(unifiedText(f.text) && ['current_sequence','historical','flashback','reported','hypothetical','uncertain'].includes(f.temporalRole) && ['confirmed','uncertain','conflict','unknown'].includes(f.certainty), 'UNIFIED_FACT_SEMANTICS_INVALID');
      unifiedEvidence(f.evidenceSpans, sources, f.tempFactId);
      const subject = entities.get(f.subjectTempRef);
      unifiedAssert(!!subject, 'UNIFIED_SUBJECT_DANGLING');
      unifiedAssert(!['character','relationship'].includes(f.domain) || subject.type === 'person', 'UNIFIED_PERSON_REQUIRED');
      unifiedAssert(!['world','narrative'].includes(f.domain) || subject.type === 'world', 'UNIFIED_WORLD_REQUIRED');
      unifiedKeys(f.values, [contract.value], 'values');
      const v = f.values[contract.value];
      unifiedAssert(v !== undefined, 'UNIFIED_TYPED_VALUE_REQUIRED');
      const effect=f.effect || 'set';
      unifiedAssert(['set','clear','remove'].includes(effect),'UNIFIED_EFFECT_INVALID');
      unifiedAssert(effect==='set' || (f.certainty==='confirmed' && f.temporalRole==='current_sequence' && contract.field && f.claimKind!=='thread'),'UNIFIED_EFFECT_EVIDENCE_REQUIRED');
      unifiedAssert(effect!=='remove' || contract.collection===true,'UNIFIED_REMOVE_KIND_INVALID');
      const profileItemKind=['character_preference','character_boundary'].includes(f.claimKind);
      const validateProfileCollection=()=>{
        unifiedAssert(Array.isArray(v) && v.length<=32 && (effect==='clear' || v.length>0),'UNIFIED_CHARACTER_PROFILE_INVALID');
        for(const item of v){
          if(typeof item==='string' && allowLegacyProfileStrings===true){unifiedAssert(unifiedText(item),'UNIFIED_PROFILE_LEGACY_ITEM_INVALID');continue;}
          unifiedKeys(item,f.claimKind==='character_preference'?['content','topic','kind']:['content','topic','kind','scope'],'profile_item');
          unifiedAssert(unifiedText(item.content,1000)&&unifiedText(item.topic,140)
            && ['preference','dislike','fear','boundary','medical_or_food_boundary'].includes(item.kind),'UNIFIED_PROFILE_ITEM_INVALID');
          if(f.claimKind==='character_boundary'){
            unifiedKeys(item.scope,['subjectRef','targetRef','act','when'],'boundary_scope');
            const scope=item.scope;
            const textAxis=value=>typeof value==='string'&&value.length<=200&&!CANONICAL_META_LEAK_PATTERN.test(value);
            unifiedAssert(entities.get(scope.subjectRef)?.type==='person'&&scope.subjectRef===f.subjectTempRef
              &&(scope.targetRef===''||entities.has(scope.targetRef))&&textAxis(scope.act)&&textAxis(scope.when),'UNIFIED_BOUNDARY_SCOPE_INVALID');
          }
        }
        unifiedAssert(effect!=='remove'||v.length>0,'UNIFIED_PROFILE_REMOVE_SELECTOR_REQUIRED');
      };
      if(effect==='clear' && contract.collection===true && contract.profile===true
        && profileItemKind){
        unifiedAssert(v!==null||allowLegacyProfileStrings===true,'UNIFIED_PROFILE_SELECTOR_REQUIRED');
        unifiedAssert(v===null || (Array.isArray(v) && v.length>0 && v.length<=32),'UNIFIED_PROFILE_SELECTOR_REQUIRED');
        if(Array.isArray(v))validateProfileCollection();
      } else if(effect==='clear')unifiedAssert(v===null,'UNIFIED_CLEAR_REQUIRES_NULL');
      else if (contract.value.endsWith('Ref')) {
        const target = entities.get(v);
        unifiedAssert(!!target && (!contract.refType || target.type === contract.refType), 'UNIFIED_VALUE_REFERENCE_INVALID');
        unifiedAssert(f.subjectTempRef !== v, 'UNIFIED_SELF_REFERENCE');
        if (f.claimKind==='location') unifiedAssert(target.kind==='location','UNIFIED_LOCATION_KIND_INVALID');
        if (f.claimKind==='containment') unifiedAssert(subject.kind==='location' && target.kind==='location','UNIFIED_CONTAINMENT_KIND_INVALID');
        if (f.claimKind==='placement') unifiedAssert(['location','object'].includes(target.kind),'UNIFIED_CONTAINER_KIND_INVALID');
        if (f.claimKind==='management') unifiedAssert(target.type==='person' || target.kind==='organization','UNIFIED_MANAGER_KIND_INVALID');
      } else if (f.claimKind === 'rule') {
        unifiedKeys(v, ['text','scopeTempRef','exceptions'], 'rule');
        unifiedAssert(unifiedText(v.text) && entities.get(v.scopeTempRef)?.type === 'world' && Array.isArray(v.exceptions) && v.exceptions.length <= 12, 'UNIFIED_RULE_INVALID');
        for (const ex of v.exceptions) {
          unifiedKeys(ex, ['locationTempRef','condition','effect'], 'exception');
          unifiedAssert(entities.get(ex.locationTempRef)?.type === 'world' && unifiedText(ex.condition) && unifiedText(ex.effect), 'UNIFIED_RULE_EXCEPTION_INVALID');
        }
      } else if (f.claimKind === 'thread') {
        unifiedKeys(v, schema===UNIFIED_ARTIFACT_SCHEMA_V5
          ? ['summary','status','kind','interpretation','link','resolution','participants','linkCandidateAlias','participantIds','lifecycleId','linkStatus','linkPendingReason','linkTarget']
          : ['summary','status','kind','interpretation'], 'thread');
        unifiedAssert(v.kind===undefined || ['conflict','promise','question','task','other'].includes(v.kind),'UNIFIED_THREAD_KIND_INVALID');
        unifiedAssert(v.interpretation===undefined || unifiedText(v.interpretation),'UNIFIED_THREAD_INTERPRETATION_INVALID');
        // D04/T05: `link` records HOW this fact relates to the thread, and
        // `resolution` records WHY a thread is closed. Neither widens the status
        // enum: `broken` is `status:'resolved'` + `resolution:'broken'`, which
        // keeps "was this obligation met" distinct from "is this thread over"
        // without inventing an enum value the design forbids.
        if(schema===UNIFIED_ARTIFACT_SCHEMA_V5){
          unifiedAssert(v.link===undefined || UNIFIED_THREAD_LINK_KINDS.includes(v.link),'UNIFIED_THREAD_LINK_INVALID');
          unifiedAssert(v.resolution===undefined || UNIFIED_THREAD_RESOLUTION_REASONS.includes(v.resolution),'UNIFIED_THREAD_RESOLUTION_INVALID');
          unifiedAssert(!v.resolution || ['resolved','closed'].includes(v.status),'UNIFIED_THREAD_RESOLUTION_REQUIRES_CLOSED_STATUS');
          unifiedAssert(allowCandidateAlias || v.linkCandidateAlias===undefined,'UNIFIED_THREAD_REQUEST_ALIAS_NOT_CANONICAL');
          if(v.linkCandidateAlias!==undefined)unifiedAssert(unifiedText(v.linkCandidateAlias,120),'UNIFIED_THREAD_REQUEST_ALIAS_INVALID');
          if(v.participants!==undefined){
            unifiedAssert(Array.isArray(v.participants)&&v.participants.length>=1&&v.participants.length<=8,'UNIFIED_THREAD_PARTICIPANTS_INVALID');
            const roles=new Set();
            for(const participant of v.participants){
              unifiedKeys(participant,['role','personTempRef'],'thread_participant');
              unifiedAssert(['owner','target','participant'].includes(participant.role)
                && entities.get(participant.personTempRef)?.type==='person'&&!roles.has(participant.role),'UNIFIED_THREAD_PARTICIPANT_INVALID');
              roles.add(participant.role);
            }
          }
          if(v.participantIds!==undefined){
            unifiedAssert(Array.isArray(v.participantIds)&&v.participantIds.length>=1&&v.participantIds.length<=8,'UNIFIED_THREAD_PARTICIPANT_IDS_INVALID');
            const roles=new Set();
            for(const participant of v.participantIds){
              unifiedKeys(participant,['role','personId'],'thread_participant_id');
              unifiedAssert(['owner','target','participant'].includes(participant.role)&&unifiedId(participant.personId)&&!roles.has(participant.role),'UNIFIED_THREAD_PARTICIPANT_ID_INVALID');
              roles.add(participant.role);
            }
          }
          if(v.lifecycleId!==undefined)unifiedAssert(unifiedId(v.lifecycleId),'UNIFIED_THREAD_LIFECYCLE_ID_INVALID');
          if(v.linkStatus!==undefined)unifiedAssert(['new','accepted','pending'].includes(v.linkStatus),'UNIFIED_THREAD_LINK_STATUS_INVALID');
          if(v.linkPendingReason!==undefined)unifiedAssert(unifiedText(v.linkPendingReason,120),'UNIFIED_THREAD_LINK_PENDING_REASON_INVALID');
          if(v.linkTarget!==undefined){
            const target=v.linkTarget;
            if(target.schema==='libra.same_batch_thread_target.v1'){
              unifiedKeys(target,['schema','scopeKey','worldlineId','sourceDigest','subjectTempRef','factId','lifecycleId','participantIds','linkKind','targetStatus'],'thread_link_target');
              unifiedAssert(unifiedText(target.scopeKey,240)&&target.worldlineId==='main'
                &&unifiedDigestString(target.sourceDigest)&&unifiedId(target.subjectTempRef)
                &&unifiedId(target.factId)&&unifiedId(target.lifecycleId)
                &&target.linkKind==='resolve'&&UNIFIED_THREAD_ACTIVE_STATUS.includes(target.targetStatus),'UNIFIED_SAME_BATCH_THREAD_TARGET_INVALID');
            }else{
            unifiedKeys(target,['schema','lifecycleId','canonicalOriginKey','cursor','factId','participantIds','lineageDigest','linkKind','targetStatus'],'thread_link_target');
            unifiedAssert(target.schema==='libra.thread_link_target.v2','UNIFIED_THREAD_LINK_TARGET_SCHEMA_INVALID');
            unifiedAssert(unifiedId(target.lifecycleId)&&unifiedId(target.factId),'UNIFIED_THREAD_LINK_TARGET_ID_INVALID');
            unifiedAssert(UNIFIED_THREAD_LINK_KINDS.includes(target.linkKind)
              &&['open','blocked','uncertain','resolved','closed'].includes(target.targetStatus),'UNIFIED_THREAD_LINK_TARGET_TRANSITION_INVALID');
            unifiedAssert(unifiedDigestString(target.lineageDigest)&&unifiedDigestString(target.canonicalOriginKey),'UNIFIED_THREAD_LINK_TARGET_LINEAGE_INVALID');
            const cursor=asObject(target.cursor);
            unifiedKeys(cursor,['schema','canonicalOrigin','canonicalOriginKey','sessionEpoch','logicalWorldlineId','worldlineId','turnRange','inheritedSessionHistory'],'thread_link_cursor');
            const origin=asObject(cursor.canonicalOrigin);
            unifiedKeys(origin,['scopeKey','memoryId','revision','sourceDigest','artifactDigest','turnRange'],'thread_link_origin');
            unifiedAssert(cursor.schema==='libra.thread_target_cursor.v1'&&unifiedId(origin.memoryId)&&Number(origin.revision)>0
              &&unifiedDigestString(origin.sourceDigest)&&unifiedDigestString(origin.artifactDigest)&&Number(origin.turnRange?.end)>0
              &&unifiedDigestString(cursor.canonicalOriginKey)&&cursor.canonicalOriginKey===digest(origin)
              &&target.canonicalOriginKey===cursor.canonicalOriginKey&&cursor.logicalWorldlineId==='main'
              &&unifiedText(cursor.worldlineId,160)&&Number.isFinite(Number(cursor.sessionEpoch))
              &&Number(cursor.turnRange?.start)>0&&Number(cursor.turnRange?.end)>=Number(cursor.turnRange?.start)
              &&typeof cursor.inheritedSessionHistory==='boolean','UNIFIED_THREAD_LINK_CURSOR_INVALID');
            }
          }
          if(v.linkStatus==='accepted')unifiedAssert(!!v.linkTarget&&v.lifecycleId===v.linkTarget.lifecycleId
            &&(v.linkTarget.schema==='libra.same_batch_thread_target.v1'
              ||v.linkTarget.canonicalOriginKey===v.linkTarget.cursor?.canonicalOriginKey)
            &&v.link===v.linkTarget.linkKind&&digest(asArray(v.participantIds))===digest(asArray(v.linkTarget.participantIds)),'UNIFIED_THREAD_ACCEPTED_LINK_INCOMPLETE');
          if(v.linkStatus==='pending')unifiedAssert(!!v.lifecycleId&&!!v.linkPendingReason&&!v.linkTarget,'UNIFIED_THREAD_PENDING_LINK_INCOMPLETE');
          if(v.linkStatus==='new')unifiedAssert(!!v.lifecycleId&&!v.linkTarget&&!v.linkPendingReason&&!v.link,'UNIFIED_THREAD_NEW_LIFECYCLE_INVALID');
          if(v.linkTarget!==undefined)unifiedAssert(v.linkStatus==='accepted','UNIFIED_THREAD_TARGET_WITHOUT_ACCEPTANCE');
          if(v.linkStatus==='accepted'&&v.link==='resolve')unifiedAssert(['resolved','closed'].includes(v.status)&&!!v.resolution,'UNIFIED_THREAD_RESOLVE_REQUIRES_REASON');
          if(v.linkStatus==='accepted'&&v.link==='reopen')unifiedAssert(v.status==='open'&&!v.resolution,'UNIFIED_THREAD_REOPEN_INVALID');
        }
        unifiedAssert(unifiedText(v.summary) && ['open','blocked','uncertain','resolved','closed'].includes(v.status), 'UNIFIED_THREAD_INVALID');
      } else if (f.claimKind === 'affiliation') {
        unifiedKeys(v,['organizationTempRef','role','status'],'affiliation');
        unifiedAssert(entities.get(v.organizationTempRef)?.kind==='organization' && unifiedText(v.role) && ['member','former'].includes(v.status),'UNIFIED_AFFILIATION_INVALID');
      } else if (f.claimKind === 'access') {
        unifiedKeys(v, ['personTempRef','permission','status'], 'access');
        unifiedAssert(entities.get(v.personTempRef)?.type === 'person' && unifiedText(v.permission) && ['granted','denied','unknown'].includes(v.status), 'UNIFIED_ACCESS_INVALID');
      } else if (profileItemKind) {
        validateProfileCollection();
      } else if (contract.collection === true) {
        unifiedAssert(Array.isArray(v) && v.length <= 32 && (!contract.profile || v.length > 0) && v.every(x => unifiedText(x)), f.claimKind==='knowledge'?'UNIFIED_KNOWLEDGE_INVALID':'UNIFIED_CHARACTER_PROFILE_INVALID');
      } else unifiedAssert(unifiedText(v), 'UNIFIED_VALUE_INVALID');
      if (f.domain === 'relationship') unifiedAssert(entities.get(f.targetTempRef)?.type === 'person' && f.targetTempRef !== f.subjectTempRef && CONTINUITY_STATE_RELATION_DIMENSIONS.includes(f.dimension), 'UNIFIED_RELATION_INVALID');
      else unifiedAssert(f.targetTempRef === undefined && f.dimension === undefined, 'UNIFIED_UNEXPECTED_RELATION');
      unifiedAssert(f.dependsOn === undefined || (Array.isArray(f.dependsOn) && f.dependsOn.length <= 20), 'UNIFIED_DEPENDENCY_INVALID');
    };
    const UNIFIED_THREAD_CLOSED_STATUS = Object.freeze(['resolved','closed']);
    const UNIFIED_THREAD_ACTIVE_STATUS = Object.freeze(['open','blocked','uncertain']);
    const unifiedThreadAnchorTokens = value => new Set(
      String(value || '').toLowerCase().split(/[^0-9a-z가-힣]+/u)
        .map(token => token.replace(/(?:겠다는|겠다고|겠어요|겠어|했다|하였|한다|하는|할|한|준|했다|약속의|약속|맹세|이행|파기|약조|반드시|꼭|에게|한테|에서|으로|께서|에게서|은|는|이|가|을|를|의|에|와|과|도|만|로)$/u, ''))
        .filter(token => token.length >= 2));
    const unifiedThreadAnchorSimilarity = (left, right) => {
      const a = unifiedThreadAnchorTokens([left?.summary, left?.interpretation].filter(Boolean).join(' '));
      const b = unifiedThreadAnchorTokens([right?.summary, right?.interpretation].filter(Boolean).join(' '));
      if (!a.size || !b.size) return 0;
      let intersection = 0;
      for (const token of a) if (b.has(token)) intersection += 1;
      return intersection / Math.max(1, a.size + b.size - intersection);
    };
    const unifiedThreadEvidenceAnchorSimilarity = (target,fact) => {
      const a=unifiedThreadAnchorTokens([target?.summary,target?.interpretation].filter(Boolean).join(' '));
      const b=new Set(asArray(fact?.evidenceSpans).flatMap(span=>[...unifiedThreadAnchorTokens(span?.quote||'')]));
      if(!a.size||!b.size)return 0;
      let intersection=0;for(const token of a)if(b.has(token))intersection++;
      return intersection/Math.max(1,a.size+b.size-intersection);
    };
    const unifiedRecordAdmissionValid = (memory,ref=null) => {
      const admission=memory?.artifactValidation?.admission, expected=ref?.recordAdmissionDigest||memory?.recordAdmissionDigest;
      if(!admission&&!expected)return true; // Existing v4 memories remain readable.
      return admission?.schema==='libra.record_admission.v1' && !!expected && expected===digest(admission)
        && memory.recordAdmissionDigest===expected;
    };
    const validateUnifiedArtifact = (artifact, batch, options = {}) => {
      try {
        unifiedKeys(artifact, ['schema','entities','facts','stateBindings'], 'artifact');
        unifiedAssert(unifiedArtifactSchemaReadable(artifact.schema), 'UNIFIED_SCHEMA_INVALID');
        unifiedAssert(asArray(batch).length === BATCH_SIZE, 'UNIFIED_FIVE_PAIRS_REQUIRED');
        const sources = canonicalEvidenceSources(batch);
        unifiedAssert(sources.size === 10, 'UNIFIED_SOURCE_ROLES_INVALID');
        unifiedAssert(Array.isArray(artifact.entities) && artifact.entities.length <= 100, 'UNIFIED_ENTITIES_INVALID');
        unifiedAssert(Array.isArray(artifact.facts) && artifact.facts.length > 0 && artifact.facts.length <= 120, 'UNIFIED_FACTS_INVALID');
        unifiedAssert(Array.isArray(artifact.stateBindings) && artifact.stateBindings.length <= 120, 'UNIFIED_BINDINGS_INVALID');
        unifiedAssert(JSON.stringify(artifact).length <= 120000, 'UNIFIED_ARTIFACT_TOO_LARGE');
        const entities = new Map(), facts = new Map();
        for (const e of artifact.entities) {
          validateUnifiedEntityRecord(e,entities,sources);
          entities.set(e.tempId, e);
        }
        for (const f of artifact.facts) {
          validateUnifiedFactRecord(f,entities,facts,sources,artifact.schema,options.allowCandidateAlias===true,options.allowLegacyProfileStrings===true);
          facts.set(f.tempFactId, f);
        }
        const visiting = new Set(), visited = new Set();
        const visit = idValue => {
          unifiedAssert(facts.has(idValue) && !visiting.has(idValue), 'UNIFIED_FACT_DEPENDENCY_INVALID');
          if (visited.has(idValue)) return;
          visiting.add(idValue); for (const dep of asArray(facts.get(idValue).dependsOn)) visit(dep);
          visiting.delete(idValue); visited.add(idValue);
        };
        for (const idValue of facts.keys()) visit(idValue);
        const bound = new Set();
        for (const b of artifact.stateBindings) {
          unifiedKeys(b, ['factTempId','typedValueField','stateDomain','stateField'], 'binding');
          const f = facts.get(b.factTempId), c = f && UNIFIED_CLAIMS[f.claimKind];
          unifiedAssert(c && c.field && b.typedValueField === c.value && b.stateField === c.field && b.stateDomain === c.domain && !bound.has(b.factTempId), 'UNIFIED_BINDING_INVALID');
          bound.add(b.factTempId);
        }
        return { ok: true, schema: string(artifact.schema || UNIFIED_ARTIFACT_SCHEMA), issues: [], sourceDigest: sourceDigest(batch) };
      } catch (error) { return { ok: false, schema: string(artifact?.schema || UNIFIED_ARTIFACT_SCHEMA), issues: [string(error.message || error)] }; }
    };
    const unifiedProjection = artifact => {
      const out = { schema: CANONICAL_ARTIFACT_SCHEMA, chronology: [], characters: [], relationships: [], world: [], openThreads: [], uncertainties: [], recallTerms: [] };
      const entityMap = new Map(artifact.entities.map(e => [e.tempId,e]));
      const used = new Set();
      for (const f of artifact.facts) {
        used.add(f.subjectTempRef); if (f.targetTempRef) used.add(f.targetTempRef);
        for (const [k,v] of Object.entries(f.values)) if (k.endsWith('Ref')) used.add(v);
        const subject = entityMap.get(f.subjectTempRef), target = entityMap.get(f.targetTempRef);
        const row = { text: f.text, fact: f.text, state: f.text, event: f.text, thread: f.text, name: subject?.name,
          kind: subject?.kind, subject: subject?.name, target: target?.name, dimension: f.dimension,
          actors: [subject,target].filter(e=>e?.type==='person').map(e=>e.name),
          evidenceRefs: [...new Set(f.evidenceSpans.map(s=>s.ref))], evidenceSpans: clone(f.evidenceSpans),
          temporalRole: f.temporalRole, certainty: f.certainty, status: f.values.thread?.status || 'open' };
        // Uncertain/reported/historical facts remain memories but never become current State.
        if (f.certainty !== 'confirmed') out.uncertainties.push(row);
        else out[({event:'chronology',character:'characters',relationship:'relationships',world:'world',narrative:'openThreads'})[f.domain]].push(row);
        // v5 preference/boundary rows carry their subject scope; the v3 projection
        // already receives them through the `character` bucket above, so nothing
        // is duplicated here. The scope travels on the fact itself.
      }
      out.recallTerms = [...used].map(ref=>entityMap.get(ref)?.name).filter(Boolean);
      return out;
    };
    const renderUnifiedArtifact = artifact => renderCanonicalArtifact(unifiedProjection(artifact));
    const unifiedInheritedRef = ref => ref?.inheritedSessionHistory === true || Number(ref?.sessionEpoch || 0) < 0;
    const unifiedOriginIdentity = memory => clone(memory?.unifiedOrigin || {
      scopeKey:memory?.scopeKey, memoryId:memory?.memoryId, revision:memory?.revision,
      sourceDigest:memory?.sourceDigest, artifactDigest:memory?.artifactDigest, turnRange:memory?.turnRange
    });
    const unifiedOriginKey = memory => digest(unifiedOriginIdentity(memory));
    // A durable target records canonical origin identity and source chain position,
    // never a physical storage key. Native copies and handoffs can rebind that key.
    const unifiedThreadTargetCursor = (ref,memory,logicalWorldlineId='main') => ({
      schema:'libra.thread_target_cursor.v1',canonicalOrigin:unifiedOriginIdentity(memory),canonicalOriginKey:unifiedOriginKey(memory),
      sessionEpoch:Number(ref?.sessionEpoch||0),logicalWorldlineId:string(logicalWorldlineId||'main'),
      worldlineId:string(ref?.worldlineId||memory?.worldlineId||'main'),turnRange:clone(ref?.turnRange||memory?.turnRange||{}),
      inheritedSessionHistory:unifiedInheritedRef(ref)
    });
    const newUnifiedThreadTargetIndex = () => ({lineage:[],byLifecycle:new Map(),position:0});
    const appendUnifiedThreadTargets = (index,ref,memory,logicalWorldlineId='main') => {
      const cursor=unifiedThreadTargetCursor(ref,memory,logicalWorldlineId),position=index.lineage.length;
      index.lineage.push(cursor.canonicalOriginKey);index.position=index.lineage.length;
      if(memory?.canonicalArtifact?.schema!==UNIFIED_ARTIFACT_SCHEMA_V5)return;
      const names=new Map(asArray(memory.canonicalArtifact.entities).map(entity=>[entity.tempId,entity.name]));
      for(const fact of asArray(memory.canonicalArtifact.facts)){
        const value=asObject(fact?.values?.thread),lifecycleId=string(value.lifecycleId||'');
        if(fact?.claimKind!=='thread'||fact?.domain!=='narrative'||fact?.certainty!=='confirmed'||fact?.temporalRole!=='current_sequence'
          ||!lifecycleId||!['new','accepted'].includes(value.linkStatus)||value.link==='associate')continue;
        const participantIds=asArray(value.participantIds).map(row=>({role:string(row?.role||''),personId:string(row?.personId||'')})).sort((a,b)=>a.role.localeCompare(b.role));
        const participants=asArray(value.participants).map(row=>({role:string(row?.role||''),name:string(names.get(row?.personTempRef)||'')})).filter(row=>row.name).sort((a,b)=>a.role.localeCompare(b.role));
        if(!participantIds.length||participants.length!==participantIds.length)continue;
        index.byLifecycle.set(lifecycleId,{lifecycleId,ref,memory,cursor,originKey:cursor.canonicalOriginKey,position,
          factId:string(fact.tempFactId),value:clone(value),participantIds,participants,
          lineageDigest:digest(index.lineage.slice(0,position+1))});
      }
    };
    const sameBatchThreadEvidenceForward = (prior,current) => {
      const ordered=fact=>asArray(fact?.evidenceSpans).map(span=>{
        const ref=string(span?.ref||''),match=/^t(\d+)-(u|a)$/.exec(ref);
        return {ref,order:match?Number(match[1])*2+(match[2]==='a'?1:0):Infinity};
      });
      const before=ordered(prior),after=ordered(current);
      if(!before.length||!after.length||[...before,...after].some(row=>!Number.isFinite(row.order)))return false;
      const lastOpeningOrder=Math.max(...before.map(row=>row.order));
      const openingRefs=new Set(before.map(row=>row.ref));
      // A closure may also cite the opening row; only new evidence can establish
      // the later outcome. Every new row must follow the *last* opening row.
      const outcomeRows=after.filter(row=>!openingRefs.has(row.ref));
      return outcomeRows.length>0&&outcomeRows.every(row=>row.order>lastOpeningOrder);
    };
    const sameBatchThreadTarget = (memory,value,currentFact) => {
      const target=asObject(value?.linkTarget),facts=asArray(memory?.canonicalArtifact?.facts);
      const transferred=asObject(memory?.unifiedTransfer);
      const scopeBound=target.scopeKey===memory.scopeKey
        ||(transferred.sourceScopeKey===target.scopeKey&&transferred.targetScopeKey===memory.scopeKey
          &&transferred.artifactDigest===memory.artifactDigest);
      if(target.schema!=='libra.same_batch_thread_target.v1'||!scopeBound
        ||target.worldlineId!==string(memory.worldlineId||'main')||target.sourceDigest!==memory.sourceDigest
        ||target.subjectTempRef!==currentFact?.subjectTempRef||target.linkKind!==value.link
        ||target.lifecycleId!==value.lifecycleId)return {ok:false,reason:'same_batch_target_binding_mismatch'};
      const index=facts.findIndex(f=>f===currentFact||f?.tempFactId===currentFact?.tempFactId);
      const prior=facts.find((f,i)=>i<index&&f?.tempFactId===target.factId&&f?.claimKind==='thread'&&f?.domain==='narrative');
      const previous=asObject(prior?.values?.thread),subject=asArray(memory.canonicalArtifact.entities)
        .find(e=>e.tempId===target.subjectTempRef&&e.type==='world'&&e.kind==='thread');
      if(!prior||!subject||prior.certainty!=='confirmed'||prior.temporalRole!=='current_sequence'
        ||currentFact.certainty!=='confirmed'||currentFact.temporalRole!=='current_sequence'
        ||prior.subjectTempRef!==currentFact.subjectTempRef
        ||previous.linkStatus!=='new'||previous.lifecycleId!==value.lifecycleId
        ||previous.status!==target.targetStatus||!UNIFIED_THREAD_ACTIVE_STATUS.includes(previous.status)
        ||string(previous.kind||'other')!==string(value.kind||'other')
        ||digest(previous.participantIds)!==digest(value.participantIds)
        ||digest(target.participantIds)!==digest(value.participantIds)
        ||digest(previous.summary)!==digest(value.summary)
        ||digest(asArray(subject.evidenceSpans))!==digest(asArray(prior.evidenceSpans))
        ||!sameBatchThreadEvidenceForward(prior,currentFact)
        ||value.link!=='resolve'||!UNIFIED_THREAD_CLOSED_STATUS.includes(value.status)||!value.resolution)
        return {ok:false,reason:'same_batch_target_unproven'};
      const matches=facts.slice(0,index).filter(f=>f?.claimKind==='thread'&&f?.domain==='narrative'
        &&f.subjectTempRef===prior.subjectTempRef&&digest(f.values?.thread?.participantIds)===digest(value.participantIds)
        &&digest(f.values?.thread?.summary)===digest(value.summary)
        &&sameBatchThreadEvidenceForward(f,currentFact));
      if(matches.length!==1)return {ok:false,reason:'same_batch_target_ambiguous'};
      return {ok:true,targetFact:prior};
    };
    const validateCanonicalThreadTarget = (memory,value,threadTargetIndex=null,currentFact=null) => {
      if(value?.linkTarget?.schema==='libra.same_batch_thread_target.v1')
        return sameBatchThreadTarget(memory,value,currentFact);
      const target=asObject(value?.linkTarget),cursor=asObject(target.cursor);
      if(value?.linkStatus!=='accepted'||!Object.keys(target).length)return {ok:false,reason:'thread_link_target_missing'};
      const match=threadTargetIndex?.byLifecycle?.get(string(target.lifecycleId||''));
      if(!match)return {ok:false,reason:'thread_target_canonical_fact_missing'};
      const origin=asObject(cursor.canonicalOrigin);
      if(target.factId!==match.factId||target.canonicalOriginKey!==match.originKey
        ||cursor.canonicalOriginKey!==match.originKey||digest(origin)!==match.originKey
        ||digest(origin)!==digest(match.cursor.canonicalOrigin))return {ok:false,reason:'thread_target_canonical_fact_mismatch'};
      if(target.lineageDigest!==match.lineageDigest||target.lineageDigest!==digest(threadTargetIndex.lineage.slice(0,match.position+1)))
        return {ok:false,reason:'thread_target_lineage_changed'};
      if(match.position>=threadTargetIndex.position||match.originKey===unifiedOriginKey(memory))return {ok:false,reason:'thread_target_not_forward'};
      if(Number(cursor.turnRange?.start)!==Number(match.cursor.turnRange?.start)
        ||Number(cursor.turnRange?.end)!==Number(match.cursor.turnRange?.end))return {ok:false,reason:'thread_target_cursor_mismatch'};
      if(target.targetStatus!==match.value.status)return {ok:false,reason:'thread_target_status_stale'};
      if(target.linkKind!==value.link||target.lifecycleId!==value.lifecycleId
        ||digest(asArray(target.participantIds))!==digest(asArray(value.participantIds))
        ||digest(asArray(target.participantIds))!==digest(match.participantIds)
        ||string(value.kind||'other')!==string(match.value.kind||'other'))return {ok:false,reason:'thread_target_identity_mismatch'};
      const allowed=UNIFIED_THREAD_CLOSED_STATUS.includes(match.value.status)?['reopen','associate']
        :['reaffirm','replace','resolve','associate'];
      if(!allowed.includes(value.link))return {ok:false,reason:'thread_target_transition_disallowed'};
      const ranked=[...threadTargetIndex.byLifecycle.values()].filter(row=>
        (UNIFIED_THREAD_CLOSED_STATUS.includes(row.value.status)?['reopen','associate']:['reaffirm','replace','resolve','associate']).includes(value.link)
        &&digest(row.participantIds)===digest(match.participantIds)
        &&string(row.value.kind||'other')===string(match.value.kind||'other'))
        .map(row=>({row,score:unifiedThreadAnchorSimilarity(row.value,value)})).filter(row=>row.score>=0.12).sort((a,b)=>b.score-a.score);
      if(!ranked.some(row=>row.row===match))return {ok:false,reason:'thread_target_anchor_mismatch'};
      if(ranked.length>1&&ranked[0].score-ranked[1].score<0.12)return {ok:false,reason:'thread_target_anchor_ambiguous'};
      if(ranked[0]?.row!==match)return {ok:false,reason:'thread_target_not_best_match'};
      if(unifiedThreadEvidenceAnchorSimilarity(match.value,currentFact)<0.12)return {ok:false,reason:'thread_anchor_evidence_missing'};
      if(value.link==='resolve'&&(!UNIFIED_THREAD_ACTIVE_STATUS.includes(match.value.status)||!['resolved','closed'].includes(value.status)||!value.resolution))
        return {ok:false,reason:'thread_resolve_transition_invalid'};
      if(value.link==='reopen'&&(!UNIFIED_THREAD_CLOSED_STATUS.includes(match.value.status)||value.status!=='open'))return {ok:false,reason:'thread_reopen_transition_invalid'};
      if(['reaffirm','replace'].includes(value.link)&&(!UNIFIED_THREAD_ACTIVE_STATUS.includes(match.value.status)||!UNIFIED_THREAD_ACTIVE_STATUS.includes(value.status)))
        return {ok:false,reason:'thread_active_transition_invalid'};
      return {ok:true,targetRef:match.ref,targetIndex:match.position,currentIndex:threadTargetIndex.position};
    };
function memorySuiteReviewFingerprint(value) {
  const body = typeof value === 'string' ? value : JSON.stringify(value);
  let a = 2166136261, b = 2246822507;
  for (let i=0;i<body.length;i++) { const c=body.charCodeAt(i); a=Math.imul(a^c,16777619); b=Math.imul(b^c,3266489909); }
  return (a>>>0).toString(16).padStart(8,'0')+(b>>>0).toString(16).padStart(8,'0')+':'+body.length;
}

module.exports={digest,sourceDigest,sourcePairs,branchContentHash,memorySuiteReviewFingerprint,unifiedArtifactSchemaReadable,validateUnifiedArtifact,renderUnifiedArtifact,unifiedRecordAdmissionValid,unifiedOriginKey,newUnifiedThreadTargetIndex,appendUnifiedThreadTargets,validateCanonicalThreadTarget};
