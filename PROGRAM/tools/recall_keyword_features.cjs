// Canonical standalone query/evidence helper. Generated into both owner plugins.
module.exports = function createRecallKeywordFeatures() {
  const version = 'recall_evidence_plan_v6';
  const text = value => String(value ?? '');
  const recallQueryTextOf = (value, depth = 0) => {
    if (value == null || depth > 4) return '';
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) return value.map(part => recallQueryTextOf(part, depth + 1)).filter(Boolean).join('\n');
    if (typeof value !== 'object') return '';
    const fields = ['rawQuery', 'requestText', 'query', 'text', 'content', 'input', 'userInput', 'message'];
    for (const field of fields) {
      if (!Object.prototype.hasOwnProperty.call(value, field)) continue;
      const body = recallQueryTextOf(value[field], depth + 1).trim();
      if (body) return body;
    }
    if (value.queryPlan && typeof value.queryPlan === 'object') {
      return recallQueryTextOf(value.queryPlan, depth + 1);
    }
    if (Array.isArray(value.parts)) return value.parts.map(part => recallQueryTextOf(part, depth + 1)).filter(Boolean).join('\n');
    return '';
  };
  const normalize = value => recallQueryTextOf(value).normalize('NFKC').replace(/[\u200B\uFEFF]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const escape = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const particles = ['으로부터는','에게서는','한테서는','께서는','에서는','으로서는','으로써는','에게서','한테서','으로부터','에게는','한테는','으로서','으로써','께서','부터는','까지는','하고는','에는','로는','와는','과는','으로','에게','한테','에서','부터','까지','처럼','보다','하고','로서','로써','은','는','이','가','을','를','와','과','랑','도','만','의','로','야','아'];
  const suffixPattern = '(?:' + particles.map(escape).join('|') + '|님|씨|について|として|から|まで|より|では|には|へは|とは|って|なら|だけ|ほど|は|が|を|に|へ|と|で|の|も|さん|ちゃん|くん|君|様)?';
  const patterns = new Map();
  const pattern = (key,build) => {
    if(patterns.has(key))return patterns.get(key);
    if(patterns.size>=512)patterns.delete(patterns.keys().next().value);
    const result=build();patterns.set(key,result);return result;
  };
  const mentionSpans = (value, expression) => {
    const name=normalize(expression),body=normalize(value);if(!name||!body)return [];
    const re=pattern('mention:'+name,()=>new RegExp('(^|[^\\p{L}\\p{N}_\\u200C\\u200D])'+escape(name)+suffixPattern+'(?=$|[^\\p{L}\\p{N}_\\u200C\\u200D])','gu'));
    re.lastIndex=0;const out=[];let hit;
    while((hit=re.exec(body))&&out.length<128)out.push({start:hit.index+hit[1].length,end:hit.index+hit[1].length+name.length});
    return out;
  };
  const mentions = (value, expression) => {
    return mentionSpans(value,expression).length>0;
  };
  const entityKey = entry => [entry.owner || '',entry.scopeKey || entry.scope || '',entry.entityId || entry.canonical || entry.normalized].join('\0');
  const catalog = (entries=[]) => {
    const entities=new Map(), expressions=new Map();
    for(const entry of entries){
      const key=entityKey(entry), old=entities.get(key);
      const names=[...new Set([...(old?.names||[]),entry.normalized,entry.canonical,...(entry.names||[]),...(entry.aliases||[])].map(normalize).filter(Boolean))];
      entities.set(key,{...old,...entry,entityKey:key,names});
    }
    for(const [key,entry] of entities)for(const name of entry.names){if(!expressions.has(name))expressions.set(name,new Set());expressions.get(name).add(key);}
    return {entities,expressions};
  };
  const resolveMentions = (value, entries=[]) => {
    const index=catalog(entries), body=normalize(value), groups=[];
    for(const [name,owners] of index.expressions)for(const span of mentionSpans(body,name))groups.push({name,owners,...span});
    groups.sort((a,b)=>a.start-b.start||b.end-a.end);
    let furthest=-1;const result=new Map();
    for(const hit of groups){
      if(hit.end<=furthest)continue;furthest=hit.end;
      for(const key of hit.owners){const entry=index.entities.get(key);
        result.set(key+'\0'+hit.name,{...entry,matchedName:hit.name,ambiguous:hit.owners.size!==1,
          aliases:entry.names.filter(name=>name!==normalize(entry.normalized||entry.canonical)&&index.expressions.get(name)?.size===1),
          sharedAliases:entry.names.filter(name=>index.expressions.get(name)?.size>1)});
      }
    }
    return Array.from(result.values());
  };
  const hint = (value, expression) => {
    const term = normalize(expression), body = normalize(value);
    if (!term) return false;
    return /[a-z]/i.test(term)
      ? pattern('hint:'+term,()=>new RegExp('(?:^|[^\\p{L}\\p{N}_])' + escape(term).replace(/ /g, '\\s+') + '(?=$|[^\\p{L}\\p{N}_])', 'u')).test(body)
      : body.includes(term);
  };
  const topicShift = value => /(?:새(?:로운)?\s*(?:주제|화제|이야기|장면)|다른\s*(?:주제|화제|이야기|장면|장소)|(?:화제|주제)(?:를)?\s*바꾸|그건\s*됐고|별개의\s*(?:질문|이야기)|장면\s*(?:전환|변경)|시간\s*(?:점프|스킵)|한편)/u.test(normalize(value))
    || ['new topic','new subject','new scene','different topic','different subject','different scene','change the subject','change the scene','change the topic','unrelated question','unrelated topic','scene change','time skip','meanwhile'].some(t => hint(value,t));
  const continuation = value => ['계속','이어서','이어가','이어줘','continue','resume','go on','keep going','same scene','from there','続けて','そのまま'].some(t => hint(value,t));
  const referential = value => /^(?:next|그 다음)(?:\s*[?？.!！])?$/u.test(normalize(value)) || ['그거','그건','그게','그걸','그곳','거기','그때','그 사람','걔','그녀','그의','그들의','앞에서','방금','아까','그렇다면','그래서','그럼','that','it','they','them','there','then','he','she','his','her','that person','what about','and then','so what','彼女','彼','それ','そこ','その時'].some(t => hint(value,t));
  const mode = value => topicShift(value) ? 'topic_shift' : continuation(value) ? 'continuation' : referential(value) ? 'referential' : 'explicit';
  const variants = value => {
    const raw = normalize(value), out = [raw];
    if (/^[가-힣]+$/u.test(raw)) {
      // Short case endings can be part of a name (니콜로+는). Without a
      // dictionary prefer the outer topic particle; registered names resolve
      // their complete suffix through resolveMentions instead.
      const particle = particles.find(p => !['로는','와는','과는','에는'].includes(p) && raw.endsWith(p) && raw.length > p.length);
      if (particle) out.push(raw.slice(0,-particle.length));
    }
    return out.filter(Boolean);
  };
  const words = value => normalize(value).match(/[\p{L}\p{N}_:\u200C\u200D-]+/gu) || [];
  const extractSurfaceAnchors = value => {
    const body = normalize(value), out = [], seen = new Set();
    const add = (name, origin, form = 'literal') => {
      const normalized = normalize(name);
      if (!normalized || seen.has(normalized) || out.length >= 32) return;
      seen.add(normalized); out.push({ normalized, kind:'surface', origin, matchForm:form });
    };
    for (const hit of body.matchAll(/["“「『]([^"”」』\n]{1,120})["”」』]/gu)) add(hit[1],'quote');
    for (const hit of body.matchAll(/(?:^|[^\p{L}\p{N}_])([\p{L}\p{N}_-]{1,40}?)(의|에게서는|에게는|에게|한테는|께서는)(?=\s|$)/gu)) add(hit[1],'possessive_or_recipient','particle');
    if (/[?？]|어디|누구|무엇|뭐|언제|왜|어떻게/u.test(body)) {
      const subjects=Array.from(body.matchAll(/(?:^|[^\p{L}\p{N}_])([\p{L}\p{N}_-]{1,40}?)(은|는|이|가)(?=\s|$)/gu));
      for (const [i,hit] of subjects.entries()) {
        // Adjacent attributive+subject words form one nominal group, not two targets.
        // Keep the modifier in lexical search; never certify its stripped stem.
        const next=subjects[i+1];
        if(hit[2]==='은'&&next&&!body.slice(hit.index+hit[0].length,next.index).trim())continue;
        if (!/^(?:어디|무엇|뭐|누구|언제|약속|장소|상태|시간|규칙)$/u.test(hit[1])) add(hit[1],'question_subject','particle');
      }
    }
    for (const hit of body.matchAll(/(?:^|\s)([\p{L}\p{N}_-]+)'s\b/gu)) add(hit[1],'possessive');
    const tokens = words(body);
    if (tokens.length === 1 && !/^(?:continue|next|계속|이어서)$/u.test(tokens[0])) add(tokens[0],'single_query');
    for (const token of tokens) if (/\d/u.test(token) && /[a-z_-]/u.test(token)) add(token,'identifier');
    return out;
  };
  const segments = value => {
    const raw=recallQueryTextOf(value), rows=[];let fenced=false;
    for(const line of raw.matchAll(/[^\n]+(?:\n|$)/g)){
      if(/^\s*```/.test(line[0])){fenced=!fenced;rows.push({text:line[0],start:line.index,end:line.index+line[0].length,kind:'background'});continue;}
      const background=fenced||/^\s*>/.test(line[0]);
      if(background){rows.push({text:line[0],start:line.index,end:line.index+line[0].length,kind:'background'});continue;}
      // Keep inline quotes and their punctuation inside their original sentence.
      const quoteOnly=/^\s*["“「『][\s\S]*["”」』]\s*$/.test(line[0]);
      rows.push({text:line[0],start:line.index,end:line.index+line[0].length,kind:quoteOnly?'quoted_background':(/[?？]|(?:질문|요청)\s*[:：]|(?:알려|설명|찾아|보여|정리|비교|확인)(?:줘|해)|\b(?:tell|explain|find|show|describe|compare|summarize)\b/iu.test(line[0])?'request':'unclassified')});
    }
    if(!rows.some(r=>r.kind==='request')){
      const last=rows.filter(r=>r.kind==='unclassified'||r.kind==='quoted_background').at(-1);
      if(last)last.kind='request';
    }
    return rows.map(r=>Object.freeze({...r,kind:r.kind==='request'?'request':'background'}));
  };
  const digest = value => {let h=2166136261;for(const c of String(value))h=Math.imul(h^c.codePointAt(0),16777619);return (h>>>0).toString(16);};
  const snapshot = value => Array.isArray(value)?Object.freeze(value.map(snapshot)):value&&typeof value==='object'?Object.freeze(Object.fromEntries(Object.entries(value).map(([key,item])=>[key,snapshot(item)]))):value;
  const plans=new Map();let planChars=0;
  const requestSpec = (value, source={}) => {
    if(value?.kind==='recall_request_spec')return value;
    const raw=recallQueryTextOf(value),parts=segments(raw);
    const analyzedQuotes=parts.filter(p=>p.kind==='request').flatMap(p=>Array.from(p.text.matchAll(/["“「『]([^"”」』]*)["”」』]/gu),m=>({role:'analysis_quotation',start:p.start+m.index+1,end:p.start+m.index+m[0].length-1,text:m[1]})));
    const declaredIntent = value && typeof value === 'object' && !Array.isArray(value) ? intent(value) : null;
    return snapshot({analyzedQuotes,kind:'recall_request_spec',id:'request:'+digest(raw+JSON.stringify(source)+JSON.stringify(declaredIntent)),raw,source,segments:parts,declaredIntent});
  };
  // Record semantics are producer-owned. Structured fields and namespace
  // markers take precedence; the legacy temporal/dispute hints below are
  // retained only as a query compatibility layer and never classify records.
  const INTENT_TEMPORAL_VALUES = new Set(['past', 'historical', 'timeline', 'current', 'present', 'compare', 'comparison']);
  const INTENT_TRUTH_VALUES = new Set(['disputed', 'contested', 'conflicting', 'uncertain', 'unknown', 'unverified', 'normal']);
  const intent = value => {
    const source = value && typeof value === 'object' ? value : {};
    const raw = normalize(typeof value === 'string' ? value : text(source.rawQuery || source.query || source.requestText || source.text || ''));
    const plans = [source.declaredIntent, source.intent, source.queryIntent, source.query_intent, source.queryPlan?.intent, source.queryPlan, source.plan, source]
      .filter(item => item && typeof item === 'object' && !Array.isArray(item));
    const markers = {};
    for (const match of raw.matchAll(/(?:^|[^\p{L}\p{N}_])([a-z][a-z0-9_-]{1,31}):([^\s,;|]+)/giu)) {
      const key = String(match[1] || '').toLowerCase();
      const token = normalize(String(match[2] || '').replace(/[.!?)}\]>]+$/gu, ''));
      if (token && markers[key] == null) markers[key] = token;
    }
    const pick = keys => {
      for (const plan of plans) for (const key of keys) {
        if (!Object.prototype.hasOwnProperty.call(plan, key)) continue;
        const token = normalize(plan[key]);
        if (token) return token;
      }
      return '';
    };
    const temporalRaw = pick(['temporal', 'temporalIntent', 'temporal_intent', 'timeScope', 'time_scope'])
      || markers.temporal || markers.time || '';
    const control = raw.replace(/["“「『][^"”」』]*["”」』]/gu, '');
    const legacyPast = /(?:과거|예전|이전|당시|지난|\bpast\b|\bbefore\b)/u.test(control);
    const legacyCurrent = /(?:지금|현재|요즘|\bnow\b|\bcurrent\b)/u.test(control);
    const legacyCompare = /(?:비교|달라|차이|변화|\bcompare\b)/u.test(control);
    const temporal = INTENT_TEMPORAL_VALUES.has(temporalRaw)
      ? temporalRaw
      : legacyCompare ? 'compare' : legacyPast && legacyCurrent ? 'uncertain' : legacyPast ? 'past' : legacyCurrent ? 'current' : 'unspecified';
    const truthRaw = pick(['truthIntent', 'truth_intent', 'truth', 'truthStatus', 'epistemicIntent', 'epistemic_intent'])
      || markers.truth || markers.epistemic || '';
    const disputed = plans.some(plan => ['disputed', 'isDisputed', 'is_disputed'].some(key => plan[key] === true || plan[key] === 1 || String(plan[key] || '').toLowerCase() === 'true'))
      || ['disputed', 'contested', 'conflicting', 'uncertain', 'unknown', 'unverified'].includes(truthRaw)
      || /(?:충돌|모순|엇갈|\bconflict\b|\bcontradict)/u.test(control);
    const compare = temporal === 'compare' || temporal === 'comparison' || legacyCompare
      || plans.some(plan => ['compare', 'comparison', 'historyComparison', 'history_comparison'].some(key => plan[key] === true || plan[key] === 1 || String(plan[key] || '').toLowerCase() === 'true'));
    const contextRaw = pick(['contextMode', 'context_mode']) || markers.context || '';
    const contextMode = ['topic_shift', 'continuation', 'referential', 'explicit'].includes(contextRaw)
      ? contextRaw
      : mode(raw.replace(/["“「『][^"”」』]*["”」』]/gu, ''));
    const transition = plans.some(plan => ['transition', 'stateTransition', 'state_transition', 'history', 'timeline'].some(key => plan[key] === true || plan[key] === 1 || String(plan[key] || '').toLowerCase() === 'true'))
      || ['transition', 'state_transition', 'history'].includes(markers.intent || '');
    return { temporal, compare, disputed, contextMode, transition,
      specified: temporal !== 'unspecified' || disputed || compare || transition || INTENT_TRUTH_VALUES.has(truthRaw) };
  };
  const compile = (value, options={}) => {
    const request=requestSpec(value),raw=request.raw;
    const entries=[...catalog(options.entries||[]).entities.values()], binding=JSON.stringify(options.binding||{});
    const key=request.id+'\0'+raw+'\0'+JSON.stringify(request.declaredIntent||null)+'\0'+JSON.stringify(entries)+'\0'+binding;
    if(plans.has(key))return plans.get(key);
    const parts=request.segments, requests=parts.filter(r=>r.kind==='request').flatMap(part=>{
      const boundaries=[0,...Array.from(part.text.matchAll(/(?<=[?？!！;；])\s+|(?<=위치|장소)와\s+(?=.+(?:현재|예전|과거))/gu),m=>m.index+m[0].length),part.text.length];
      return boundaries.slice(0,-1).map((start,i)=>({text:part.text.slice(start,boundaries[i+1]),start:part.start+start,end:part.start+boundaries[i+1],kind:'request'})).filter(r=>r.text.trim());
    });
    const requestText=requests.map(r=>r.text).join('\n'), controlText=requestText.replace(/["“「『][^"”」』]*["”」』]/gu,''), contextMode=request.declaredIntent?.contextMode && request.declaredIntent.contextMode !== 'unspecified' ? request.declaredIntent.contextMode : mode(controlText);
    const resolved=resolveMentions(requestText,entries), targets=[], seen=new Set();
    const add=(anchor,part)=>{
      const name=normalize(anchor.normalized||anchor.canonical||'');
      if(!name||seen.has(name+part.start)||targets.length>=32)return;
      const reference=['그','그녀','그들','그 사람','사람','걔','it','he','she','they','them','his','her','that','there','彼','彼女','それ','そこ'].includes(name);
      if(reference&&anchor.kind!=='person')return;
      seen.add(name+part.start);targets.push(snapshot({...anchor,normalized:name,id:'target:'+targets.length,origin:anchor.origin||'request',kind:anchor.kind||'surface',matchForm:anchor.matchForm||'literal',segmentStart:part.start,segmentEnd:part.end,sourceExpression:anchor.matchedName||name,confidence:anchor.kind==='person'?'declared':anchor.origin==='question_subject'?'slot_head':'explicit',aliases:options.binding?.catalogComplete===false?[]:[...(anchor.aliases||[])]}));
    };
    // Work backwards across actual requests, never across quoted background first.
    for(const part of [...requests].reverse()){
      const matches=resolveMentions(part.text,entries);
      for(const row of matches.filter(r=>!r.ambiguous))add({...row,normalized:row.normalized||row.canonical,kind:'person',origin:'declared_public_entity'},part);
      for(const anchor of extractSurfaceAnchors(part.text)){
        if(anchor.matchForm==='particle' && anchor.origin==='question_subject')continue;
        if(matches.some(r=>!r.ambiguous&&mentions(r.matchedName,anchor.normalized)))continue;
        add(anchor,part);
      }
    }
    const goals=requests.map(part=>snapshot({id:'goal:'+digest(request.id+':'+part.start+':'+part.text),text:part.text,start:part.start,end:part.end,intent:request.declaredIntent || intent(part.text),lookupHints:words(part.text)}));
    const aggregate=request.declaredIntent || intent(requestText);
    const ownership=catalog(entries);
    const plan=Object.freeze({request,goals:snapshot(goals),intent:snapshot(aggregate),catalog:snapshot({complete:options.binding?.catalogComplete===true,owners:Object.fromEntries([...ownership.expressions].map(([k,v])=>[k,[...v]]))}),id:'query:'+digest(key),version,rawQuery:raw,requestText,controlText,segments:Object.freeze(parts),targets:Object.freeze(targets),resolvedEntities:snapshot(resolved),queryMode:contextMode,context:Object.freeze({needed:['referential','continuation'].includes(contextMode),topicShift:contextMode==='topic_shift',continuation:contextMode==='continuation'}),binding:snapshot({...options.binding}),diagnostics:Object.freeze({requestSegments:requests.length,backgroundSegments:parts.filter(r=>r.kind!=='request').length,targetLimit:32,targets:targets.length,targetLimitReached:targets.length===32,sourceChars:raw.length})});
    if(key.length<=262144){while(plans.size>=32||planChars+key.length>524288){const old=plans.keys().next().value;if(old===undefined)break;planChars-=old.length;plans.delete(old);}plans.set(key,plan);planChars+=key.length;}
    return plan;
  };
  const surfaceAnchors = value => compile(value).targets;
  const prepareInput = (value, limit=6000) => {
    const raw=recallQueryTextOf(value).trim();if(raw.length<=limit)return raw;
    const plan=compile(raw), requests=plan.segments.filter(r=>r.kind==='request');
    let left=Math.max(0,limit-32), selected=[];
    for(const row of [...requests].reverse()){
      const content=row.text.trim(), take=content.slice(-left);if(take){selected.push({start:row.start,text:take});left-=take.length+1;}if(left<=0)break;
    }
    if(left>0)for(const row of plan.segments.filter(r=>r.kind!=='request')){const take=row.text.trim().slice(0,left);if(take){selected.push({start:row.start,text:take});left-=take.length+1;}if(left<=0)break;}
    let output=(selected.sort((a,b)=>a.start-b.start).map(r=>r.text).join('\n')+'\n…[input budget:'+digest(raw)+']').slice(0,limit);
    return output;
  };
  const focus = (value, anchors = surfaceAnchors(value)) => {
    const matches = anchors.filter(anchor => anchor.confidence!=='slot_head' && [anchor.normalized].some(name=>mentions(value,name)));
    return { count:matches.length, total:anchors.length, coverage:anchors.length ? matches.length / anchors.length : 0, matches };
  };
  const directAnchors = (anchors = []) => anchors.filter(anchor=>anchor.kind==='person'||!['그','그녀','그들','그 사람','사람','걔','it','he','she','they','them','his','her','that','there','彼','彼女','それ','そこ'].includes(normalize(anchor.normalized)));
  const contextRelevant = (query, body) => {
    const plan=compile(query),queryMode=plan.queryMode;
    if(queryMode==='topic_shift')return false;
    if(queryMode!=='explicit')return true;
    const anchors=surfaceAnchors(query);
    if(anchors.length)return focus(body,anchors).count>0;
    const common=new Set(['what','where','when','which','who','why','how','the','are','was','were','have','has','does','did','about','tell','explain','please','어디','누구','무엇','언제','어떻게','있어','있다','알려줘','설명해줘']);
    return words(query).flatMap(variants).filter(w=>w.length>=2&&!common.has(w)).some(w=>mentions(body,w));
  };
  // Quoted background is still searchable, but does not consume the request reserve.
  const tokens = (value, limit = 260, options = {}) => {
    const max = Math.max(1, Number(limit) || 260), plan=options.plan||compile(value),raw=plan.rawQuery,all=words(raw);
    const anchors = [...(options.anchors || []), ...plan.targets.map(a=>a.normalized)];
    const requests=plan.segments.filter(r=>r.kind==='request').map(r=>r.text);
    const question = [];
    const sections = requests.map(s=>words(s).slice(-32)).reverse();
    // Preserve the final request before distributing the rest across earlier questions.
    if(sections.length)question.push(...sections.shift());
    for (let i=0;i<32;i++) for (const section of sections) if (section[i]) question.push(section[i]);
    const out = [], seen = new Set(), stop = options.stopwords;
    const add = term => {
      if (!term || seen.has(term) || (stop && stop.has(term)) || out.length >= max) return;
      // Bare one-character requests/explicit names have an exact surface route;
      // ordinary document words retain the established minimum length.
      if (term.length < 2 && !anchors.includes(term) && options.single !== true) return;
      seen.add(term);out.push(term);
    };
    const take = (items, count) => { const end=Math.min(max,out.length+count); for(const item of items){if(out.length>=end)break;add(item);} };
    take(anchors, Math.max(1,Math.floor(max*.25)));
    take(question, Math.floor(max*.5));
    take(all, Math.floor(max*.25));
    take(question,max-out.length);
    take(all,max-out.length);
    if (options.variants !== false) for (const word of [...out]) {
      if (anchors.includes(word)) continue; // Never strip an already-resolved surface root again.
      for (const variant of variants(word)) add(variant);
    }
    if (options.grams !== false) for(const word of [...out]) {
      if(!/[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(word))continue;
      const chars=Array.from(word);
      for(const n of [2,3])for(let i=0;i+n<=chars.length&&out.length<max;i++)add(chars.slice(i,i+n).join(''));
    }
    return out;
  };
  const matches = (value, targets=[]) => {
    // Map normalized grapheme positions back to the unchanged source, including
    // NFKC expansion, combining marks and whitespace compression.
    const raw=String(value??''),map=[],chars=[];
    const chunks=typeof Intl?.Segmenter==='function'?Array.from(new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(raw),r=>({text:r.segment,index:r.index})):Array.from(raw.matchAll(/\P{M}\p{M}*|\p{M}+/gu),r=>({text:r[0],index:r.index}));
    for(const chunk of chunks)for(const ch of chunk.text.normalize('NFKC').replace(/[\u200B\uFEFF]/g,'').toLowerCase()){
      const text=/\s/u.test(ch)?' ':ch;if(text===' '&&(!chars.length||chars.at(-1)===' '))continue;
      for(let i=0;i<text.length;i++){chars.push(text[i]);map.push({start:chunk.index,end:chunk.index+chunk.text.length});}
    }
    const normalized=chars.join(''),out=[];
    for(const target of targets)for(const name of [target.normalized,...(target.aliases||[])])for(const span of mentionSpans(normalized,name)){
      if(map[span.start]&&map[span.end-1])out.push({targetId:target.id||target.normalized,start:map[span.start].start,end:map[span.end-1].end,kind:target.kind});
    }
    return out;
  };
  const evidenceCache=new WeakMap();
  const evidence = (record, plan, options={}) => {
    const body=String(record?.text??''),targets=plan?.targets||[],sourceDigest=digest(body),recordId=String(record?.id||record?.hash||sourceDigest);
    const key=digest(JSON.stringify([recordId,record.scopeKey,record.sourceRevision,record.metadata?.sourceRevision,sourceDigest,options]));
    const cached=plan&&evidenceCache.get(plan)?.get(record);
    if(cached?.key===key)return cached.rows;
    const rows=[];
    for(const target of targets){
      if(target.confidence==='slot_head')continue;
      const literal={...target,normalized:target.kind==='person' ? target.sourceExpression||target.normalized : target.normalized,aliases:[],kind:'text_match'};
      // A literal expression never proves that an alias belongs to an entity.
      for(const hit of matches(body,[literal]))rows.push({...hit,id:target.id,goalId:plan.goals?.find(g=>g.start<=target.segmentStart&&g.end>=target.segmentStart)?.id||plan.goals?.[0]?.id,
        recordId,sourceDigest,sourceRevision:record.sourceRevision||record.metadata?.sourceRevision||'',binding:plan.binding,kind:'text_match'});
      if(target.kind!=='person'||!plan.catalog?.complete||(record.scopeKey&&plan.binding?.scope&&record.scopeKey!==plan.binding.scope))continue;
      const local=(options.entities||[]).find(e=>entityKey(e)===target.entityKey);
      if(local)for(const fact of options.facts||[]){
        if(fact.renderable!==true||fact.authority==='CURRENT_USER_OVERLAY'||fact.evidenceOffsetsInvalidated)continue;
        const entity=normalize(fact.entity),namedOwner=plan.catalog.owners[normalize(local.normalized)];
        if(entity!==normalize(target.entityId)&&!(entity===normalize(local.normalized)&&namedOwner?.length===1))continue;
        const start=Number(fact.evidenceStart),end=Number(fact.evidenceEnd),excerpt=String(fact.evidenceText||'').trim();
        if(!excerpt||!Number.isInteger(start)||!Number.isInteger(end)||end<=start||start<0||end>body.length||body.slice(start,end).trim()!==excerpt)continue;
        const goal=plan.goals?.find(g=>g.start===target.segmentStart);
        if(options.properties?.length&&!options.properties.includes(fact.property))continue;
        rows.push({targetId:target.id,id:target.id,goalId:goal?.id,recordId,sourceDigest,binding:plan.binding,start,end,kind:'fact_support',entityRef:target.entityKey,factRef:fact.id||[fact.entity,fact.property,fact.value].join(':')});
      }
      if(!local)continue;
      const names=[target.normalized].filter(name=>plan.catalog.owners[normalize(name)]?.length===1&&plan.catalog.owners[normalize(name)][0]===target.entityKey);
      for(const hit of matches(body,[{...target,normalized:names[0]||'',aliases:names.slice(1)}]))rows.push({...hit,id:target.id,goalId:plan.goals?.find(g=>g.start===target.segmentStart)?.id,recordId,sourceDigest,binding:plan.binding,kind:'entity_mention'});
    }
    const result=snapshot(rows.map(row=>({...row,sourceRevision:record.sourceRevision||record.metadata?.sourceRevision||''})));
    if(plan&&record&&typeof record==='object'){if(!evidenceCache.has(plan))evidenceCache.set(plan,new WeakMap());evidenceCache.get(plan).set(record,{key,rows:result});}
    return result; 
  };
  const evidenceFocus = (record,plan,options={}) => {
    const rows=evidence(record,plan,options), ids=new Set(rows.map(r=>r.targetId)),matched=(plan?.targets||[]).filter(t=>{
      if(!ids.has(t.id))return false;
      const goal=plan.goals?.find(g=>g.start===t.segmentStart),query=goal?.text||plan.requestText||'';
      const conditions=words(query).filter(w=>w.length>=2&&!lexicalNoise.test(w)&&!(plan.targets||[]).some(a=>mentions(w,a.normalized)||mentions(w,a.sourceExpression||a.normalized)));
      return !conditions.length||conditions.some(w=>variants(w).some(v=>v.length>=2&&normalize(record.text).includes(v)));
    });
    return {count:matched.length,total:plan?.targets?.length||0,coverage:matched.length/Math.max(1,plan?.targets?.length||0),matches:matched,evidence:rows};
  };
  const fragmentEvidence = (record, fragment, rows=[]) => {
    const raw=String(record?.text??''),body=String(fragment??'');
    return rows.filter(row=>row.recordId===String(record?.id||record?.hash||digest(raw))&&row.sourceRevision===(record?.sourceRevision||record?.metadata?.sourceRevision||'')&&row.sourceDigest===digest(raw)&&row.start>=0&&row.end<=raw.length&&body.split(/\n+/).some(line=>{
      const chunk=line.trim();if(!chunk)return false;
      const offset=raw.indexOf(chunk);
      return offset>=0&&offset===raw.lastIndexOf(chunk)&&row.start>=offset&&row.end<=offset+chunk.length;
    }));
  };
  const documentTokens = (value,limit=480,options={}) => {
    const terms=words(value),out=new Set();
    const add=t=>{if(t&&t.length>=2&&!options.stopwords?.has(t)&&out.size<limit)out.add(t);};
    terms.forEach(add);
    for(const word of terms){if(options.variants!==false)variants(word).forEach(add);
      if(options.grams!==false&&/[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(word)){
        const chars=Array.from(word);for(const n of [2,3])for(let i=0;i+n<=chars.length;i++)add(chars.slice(i,i+n).join(''));
      }
    }return [...out];
  };
  const tokenFamilies = (value,terms) => {
    const parents=[...new Set(words(value))].sort((a,b)=>b.length-a.length),groups=new Map(),result=new Map();
    for(const term of terms){const parent=parents.find(word=>word===term||word.includes(term))||term;
      if(!groups.has(parent))groups.set(parent,[]);groups.get(parent).push(term);}
    for(const [parent,children] of groups)for(const term of children)result.set(term,{parent,weight:1/children.length});
    return result;
  };
  const lexicalNoise = /^(?:어디(?:에|서)?|누구|누가|무엇|뭐|언제|왜|어떻게|있어|있다|알려줘|설명해줘|질문|요청|지금|현재|예전|과거|what|where|when|which|who|why|how|the|is|are|was|were|have|has|does|did|about|tell|explain|please|now|current)$/u;
  const wholeWordSignal = (query,body) => {
    const parents=[...new Set(words(query))].filter(w=>w.length>=2&&!lexicalNoise.test(w));
    const total=parents.reduce((n,w)=>n+Math.sqrt(Array.from(w).length),0);
    return total?parents.reduce((n,w)=>n+(mentions(body,w)?Math.sqrt(Array.from(w).length):0),0)/total:0;
  };
  return Object.freeze({version,wholeWordSignal,documentTokens,tokenFamilies,requestSpec,intent,catalog,entityKey,evidence,evidenceFocus,fragmentEvidence,normalize,mentions,mentionSpans,resolveMentions,hint,mode,topicShift,referential,continuation,variants,words,segments,compile,prepareInput,matches,surfaceAnchors,directAnchors,focus,contextRelevant,tokens});
};
