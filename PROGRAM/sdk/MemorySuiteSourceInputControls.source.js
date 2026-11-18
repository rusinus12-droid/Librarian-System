/* MEMORY SUITE SOURCE INPUT CONTROLS v1 BEGIN */
// Owner input-rule controls and explicit review UI. Reanalysis stays in owner callbacks.
// 채팅에서 태그 찾기: which tags and markers the recent messages use, and how the draft rules
// treat each one, so a rule can be added without knowing tag names in advance. Local only:
// no model call, nothing stored or logged.
const MEMORY_SUITE_PRESENTATION_TAG_HINTS = Object.freeze({
  'img':'이미지','lb-xnai':'LightBoard 삽화','lb-lazy':'LightBoard 지연 표식','lb-stage':'LightBoard 무대 표식',
  'lb-stage-marker':'LightBoard 무대 표식','thoughts':'생각 블록'
});
function memorySuiteSourceTagInventory(texts, rules) {
  const found=new Map(),note=(key,kind,example)=>{const row=found.get(key)||{name:key,kind,count:0,messages:0,example:''};row.count++;if(!row.example&&example)row.example=example;found.set(key,row);return row;};
  const clip=value=>String(value||'').replace(/\s+/g,' ').trim().slice(0,80);
  for(const raw of (Array.isArray(texts)?texts:[]).slice(0,40)){
    const body=memorySuiteStripInternalSource(String(raw||'')),seen=new Set();
    const re=/<([a-z][a-z0-9:_-]*)(?=[\s/>])(?:"[^"]*"|'[^']*'|[^'">])*?>/gi;let m;
    while((m=re.exec(body))){
      const name=m[1].toLowerCase(),close=new RegExp('</'+name.replace(/[-:]/g,'\\$&')+'\\s*>','i').exec(body.slice(re.lastIndex));
      const inner=/\/\s*>$/.test(m[0])||!close?'':body.slice(re.lastIndex,re.lastIndex+close.index);
      note(name,'tag',clip(inner)||clip(m[0]));seen.add(name);
    }
    for(const [control,pattern] of [['html-comment',/<!--([\s\S]*?)-->/g],['lbdata',/\[LBDATA START\]([\s\S]*?)\[LBDATA END\]/gi],['inlay',/\{\{inlay::([^{}\r\n]+)\}\}/gi]]){
      for(const hit of body.matchAll(pattern)){note('@'+control,'control',clip(hit[1])||clip(hit[0]));seen.add('@'+control);}
    }
    for(const key of seen)found.get(key).messages++;
  }
  const lists=rules&&typeof rules==='object'?rules:{ignoredTags:[],unwrapTags:[],sourceTags:[],controls:[]};
  // Whether an item reaches the analysis is read from the projection itself, so a tag inside an
  // excluded block, or outside a 이 안만 분석 area, shows as left out even without its own rule.
  const projected=rules&&typeof rules==='object'
    ? (Array.isArray(texts)?texts:[]).slice(0,40).map(raw=>{try{return memorySuiteProjectSourceRules(memorySuiteStripInternalSource(String(raw||'')),rules).text;}catch{return String(raw||'');}}).join('\n')
    : null;
  const controlPatterns={'@html-comment':/<!--[\s\S]*?-->/,'@lbdata':/\[LBDATA START\][\s\S]*?\[LBDATA END\]/i,'@inlay':/\{\{inlay::[^{}\r\n]+\}\}/i};
  const survives=row=>projected===null||(row.kind==='control'?controlPatterns[row.name].test(projected):new RegExp('<'+row.name.replace(/[-:]/g,'\\$&')+'(?=[\\s/>])','i').test(projected));
  const treatment=row=>{
    if(row.kind==='control'&&(lists.controls||[]).includes(row.name.slice(1)))return 'ignoredTags';
    if(row.kind==='tag')for(const key of ['ignoredTags','unwrapTags','sourceTags'])if((lists[key]||[]).some(entry=>entry===row.name))return key;
    return survives(row)?'analyzed':'covered';
  };
  return [...found.values()].map(row=>({...row,treatment:treatment(row),hint:MEMORY_SUITE_PRESENTATION_TAG_HINTS[row.name]||''}))
    .sort((a,b)=>(a.treatment==='analyzed'?0:1)-(b.treatment==='analyzed'?0:1)||b.messages-a.messages||b.count-a.count||a.name.localeCompare(b.name))
    .slice(0,40);
}
// Its styles travel with it, so it looks the same inside any editor's own stylesheet.
function memorySuiteSourceFinderCss(){return `
.ms-source-settings .ms-input-finder,.ms-source-settings .ms-input-defaults-notice{display:grid;gap:8px;padding:12px;border:1px solid var(--border,#8884);border-radius:var(--r-md,11px);background:var(--surface2,transparent)}.ms-source-settings .ms-input-finder>button{justify-self:start}
.ms-source-settings .ms-finder-list{display:grid;gap:6px}.ms-source-settings .ms-finder-row{display:flex;gap:10px;align-items:center;justify-content:space-between;padding:8px 10px;border:1px solid var(--border,#8884);border-radius:var(--r-sm,8px);background:var(--surface,transparent)}.ms-source-settings .ms-finder-row[data-treatment]:not([data-treatment=analyzed]){opacity:.72}
.ms-source-settings .ms-finder-text{display:grid;gap:2px;min-width:0}.ms-source-settings .ms-finder-text code{font:600 12.5px/1.4 var(--font-mono,ui-monospace,monospace)}.ms-source-settings .ms-finder-example{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ms-source-settings .ms-finder-actions{display:flex;gap:6px;flex:none}.ms-source-settings .ms-input-defaults-notice>button{justify-self:start}
.ms-source-settings .ms-input-sync{display:grid;gap:8px;padding:12px;border:1px solid var(--border,#8884);border-radius:var(--r-md,11px);background:var(--surface2,transparent)}.ms-source-settings .ms-sync-together{display:flex;align-items:center;gap:8px;font-size:12.5px;cursor:pointer}.ms-source-settings .ms-sync-together input{width:auto;margin:0}
.ms-source-settings .ms-sync-list{display:grid;gap:4px}.ms-source-settings .ms-sync-row{display:flex;gap:10px;align-items:baseline;font-size:12.5px}.ms-source-settings .ms-sync-row b{min-width:72px}.ms-source-settings .ms-sync-row[data-state=different] span,.ms-source-settings .ms-sync-row[data-state=built_in] span{font-weight:650}.ms-source-settings .ms-sync-row[data-state=absent] span{opacity:.7}
.ms-source-settings .ms-sync-actions{display:flex;gap:8px;flex-wrap:wrap}.ms-source-settings .ms-input-sync>p:empty{display:none}
/* The recent-messages list already shows the last message; the single output stays for tools. */
.ms-source-settings .ms-input-preview:has([data-source-preview-list]:not([hidden])) :is([data-source-input-output],[data-source-input-preview-status]){display:none}
.ms-source-settings .ms-preview-list{display:grid;gap:8px}.ms-source-settings .ms-preview-items{display:grid;gap:8px}.ms-source-settings .ms-preview-item{display:grid;gap:4px;padding:8px 10px;border:1px solid var(--border,#8884);border-radius:var(--r-sm,8px)}
.ms-source-settings .ms-preview-head{display:flex;gap:8px;align-items:baseline;justify-content:space-between;flex-wrap:wrap;font-size:12px}.ms-source-settings .ms-preview-item pre{margin:0;max-height:260px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}
.ms-source-settings .ms-preview-item del{text-decoration:line-through;opacity:.55;background:color-mix(in srgb,var(--danger,#c0392b) 14%,transparent);border-radius:3px}
@media(max-width:600px){.ms-source-settings .ms-finder-row{flex-direction:column;align-items:stretch}.ms-source-settings .ms-finder-actions{flex-wrap:wrap}.ms-source-settings .ms-finder-actions button{flex:1 1 auto;white-space:nowrap}.ms-source-settings .ms-input-row select{min-width:8.5em}}
`;}
// The finder section shared by every source-rule editor. config: readSamples() → raw texts,
// draft() → current draft rules (throws while invalid), addRule(name, action), busy().
function mountMemorySuiteSourceTagFinder(host, config) {
  const doc=host.ownerDocument,make=(tag,text)=>{const node=doc.createElement(tag);if(text!==undefined)node.textContent=text;return node;};
  const area=make('section'),button=make('button','최근 메시지에서 태그 찾기'),status=make('p'),list=make('div');
  const style=make('style');style.textContent=memorySuiteSourceFinderCss();
  area.className='ms-input-finder';area.dataset.sourceTagFinder='';button.type='button';button.dataset.sourceTagFind='';
  status.dataset.sourceTagFinderStatus='';status.setAttribute('role','status');status.setAttribute('aria-live','polite');list.dataset.sourceTagFinderList='';list.className='ms-finder-list';
  area.append(style,make('strong','채팅에서 태그 찾기'),make('small','최근 메시지에 쓰인 태그와 표식을 보여 줍니다. 분석에 들어가는 것 중 뺄 것을 골라 추가한 뒤 적용을 누르세요. AI를 호출하지 않습니다.'),button,status,list);
  host.append(area);
  const labels={analyzed:'분석에 포함',ignoredTags:'내용 전체 제외',unwrapTags:'태그만 제거',sourceTags:'이 안만 분석',covered:'다른 규칙으로 빠짐'};
  const controlNames={'@html-comment':'HTML 주석','@lbdata':'LBDATA 제어 블록','@inlay':'삽화 호출'};
  let samples=null,reading=false;
  const render=()=>{
    if(!samples)return;
    let draft=null;try{draft=config.draft();}catch{}
    const rows=memorySuiteSourceTagInventory(samples,draft);
    if(!rows.length){list.replaceChildren();status.textContent='최근 메시지 '+samples.length+'개에 태그나 표식이 없습니다.';return;}
    status.textContent='최근 메시지 '+samples.length+'개에서 '+rows.length+'가지를 찾았습니다.'+(draft?'':' 규칙 초안에 오류가 있어 처리 상태는 표시하지 않습니다.');
    list.replaceChildren(...rows.map(row=>{
      const item=make('div'),title=make('code',row.kind==='control'?controlNames[row.name]||row.name:'<'+row.name+'>'),meta=make('small'),example=make('small',row.example?'예: '+row.example:'');
      item.className='ms-finder-row';item.dataset.sourceTagFinderRow=row.name;item.dataset.treatment=draft?row.treatment:'unknown';
      meta.textContent=[row.messages+'개 메시지 · '+row.count+'회',row.hint,draft?labels[row.treatment]:''].filter(Boolean).join(' · ');
      const text=make('div');text.className='ms-finder-text';text.append(title,meta);if(row.example){example.className='ms-finder-example';text.append(example);}
      if(row.name==='lb-xnai')text.append(make('small','안에 서술이 있으면 그 서술은 분석에 남고, 이미지 호출만 빠집니다.'));
      const actions=make('div');actions.className='ms-finder-actions';
      if(draft&&row.treatment==='analyzed'){
        const actionsFor=row.kind==='control'?[['ignoredTags','분석에서 빼기']]:[['ignoredTags','분석에서 빼기'],['unwrapTags','태그만 지우기']];
        for(const [key,label] of actionsFor){const add=make('button',label);add.type='button';add.dataset.sourceTagFinderAdd=key;add.disabled=config.busy?.()===true;
          add.onclick=()=>{if(config.busy?.()===true)return;config.addRule(row.kind==='control'?row.name:row.name,key);render();};actions.append(add);}
      }
      item.append(text,actions);return item;
    }));
  };
  button.onclick=async()=>{
    if(reading||config.busy?.()===true)return;reading=true;button.disabled=true;status.textContent='최근 메시지를 읽는 중…';list.replaceChildren();
    try{const texts=await config.readSamples();samples=memorySuiteSourceSampleItems(texts).map(item=>item.text);render();}
    catch{samples=null;status.textContent='현재 채팅을 읽지 못했습니다. 잠시 뒤 다시 시도하세요.';}
    finally{reading=false;button.disabled=false;}
  };
  return {refresh:render};
}
// Rows for default presentation tags a saved rule set leaves out (shown once, added as a draft).
function mountMemorySuiteMissingDefaultsNotice(host, config) {
  const doc=host.ownerDocument,make=(tag,text)=>{const node=doc.createElement(tag);if(text!==undefined)node.textContent=text;return node;};
  const box=make('div'),text=make('p'),add=make('button','빠진 기본 규칙 추가');box.className='ms-input-defaults-notice';box.dataset.sourceMissingDefaults='';box.hidden=true;add.type='button';add.dataset.sourceMissingDefaultsAdd='';
  box.append(text,add);host.append(box);
  const update=rules=>{
    const missing=memorySuiteMissingDefaultSourceTags(rules,config.owner);box.hidden=!missing.length;
    text.textContent=missing.length?'저장된 규칙에 기본 정리 대상이 빠져 있어, 다음 표시용 태그가 분석에 들어갑니다: '+missing.map(name=>'<'+name+'>').join(', ')+'. 추가한 뒤 적용을 누르면 규칙 저장 전과 같게 빠집니다.':'';
    add.onclick=()=>{if(config.busy?.()===true)return;for(const name of memorySuiteMissingDefaultSourceTags(config.draft?.()||rules,config.owner))config.addRule(name,'ignoredTags');box.hidden=true;};
  };
  return {update};
}
// Samples may be plain strings or {text, role}; every consumer reads them through this.
const memorySuiteSourceSampleItems=samples=>(Array.isArray(samples)?samples:[]).map(item=>typeof item==='string'?{text:item,role:''}:item&&typeof item.text==='string'?{text:item.text,role:String(item.role||'')}:null).filter(Boolean);
// 미리보기: the same steps as memorySuiteProjectSourceRules, tracking which characters of the
// message each step removes. When the tracked result does not equal the real projection the
// marks are not shown (exact:false), so the preview never displays a result the analysis lacks.
function memorySuiteMarkSourceProjection(value, rules) {
  const source=memorySuiteStripInternalSource(String(value??''));
  let body=source,index=Array.from({length:source.length},(_,i)=>i);
  const keep=new Uint8Array(source.length);
  const erase=ranges=>{
    if(!ranges.length)return;
    const drop=new Uint8Array(body.length);
    for(const r of ranges)for(let i=Math.max(0,r.start);i<Math.min(body.length,r.end);i++)drop[i]=1;
    let next='';const nextIndex=[];
    for(let i=0;i<body.length;i++)if(!drop[i]){next+=body[i];nextIndex.push(index[i]);}
    body=next;index=nextIndex;
  };
  let failedBack=false;
  if(rules.sourceTags.length){
    const parsed=memorySuiteSourceRanges(body,rules.sourceTags);
    if(parsed.tokens.length){
      if(parsed.invalid||parsed.ranges.length!==1||parsed.tokens.length!==2||!body.slice(parsed.ranges[0]?.innerStart,parsed.ranges[0]?.innerEnd).trim())failedBack=true;
      else{const r=parsed.ranges[0];erase([{start:0,end:r.innerStart},{start:r.innerEnd,end:body.length}]);}
    }
  }
  if(!failedBack){
    const dropped=memorySuiteSourceRanges(body,rules.ignoredTags);
    if(!dropped.invalid)erase(dropped.ranges.filter(r=>{const opening=body.slice(r.start,r.innerStart);return !(/^<lb-xnai\b/i.test(opening)&&body.slice(r.innerStart,r.innerEnd).replace(/\{\{inlay::[^{}\r\n]+\}\}/gi,'').trim());}));
    const unwrapped=memorySuiteSourceRanges(body,rules.unwrapTags);
    if(!unwrapped.invalid)erase(unwrapped.tokens);
    const patterns={'html-comment':/<!--[\s\S]*?-->/g,'lbdata':/\[LBDATA START\][\s\S]*?\[LBDATA END\]/gi,'inlay':/\{\{inlay::[^{}\r\n]+\}\}/gi,
      'suite-blocks':/\[(HAYAKU (?:PACKET MEMORY|PACKET WRITE|CONTINUITY CONTEXT|IMMUTABLE CORE|RAW SOURCE ATTACHMENT|RAW SOURCE TIMELINE)|VECTOR RAG MEMORY|FLASHBACK EVIDENCE|ACTIVE CONTINUITY EVIDENCE|PAST EVIDENCE RULES)\][\s\S]*?\[\/\1\]|<<<\s*HAYAKU_STATE_PACKET_START\s*>>>[\s\S]*?<<<\s*HAYAKU_STATE_PACKET_END\s*>>>|HAYAKU_STATE_PACKET_START\b[\s\S]*?\bHAYAKU_STATE_PACKET_END/gi};
    for(const control of rules.controls)if(patterns[control])erase([...body.matchAll(patterns[control])].map(m=>({start:m.index,end:m.index+m[0].length})));
  }
  if(failedBack){body=source;index=Array.from({length:source.length},(_,i)=>i);}
  for(const i of index)keep[i]=1;
  const segments=[];
  for(let i=0;i<source.length;i++){const removed=!keep[i],last=segments.at(-1);if(last&&last.removed===removed)last.text+=source[i];else segments.push({text:source[i],removed});}
  let expected='';try{expected=memorySuiteProjectSourceRules(source,rules).text;}catch{expected=null;}
  return {segments,text:body,exact:expected!==null&&expected===body,fallback:failedBack};
}
// Recent messages under the draft rules, removed parts struck through. Read-only and local.
function mountMemorySuiteSourcePreviewList(host, config) {
  const doc=host.ownerDocument,make=(tag,text)=>{const node=doc.createElement(tag);if(text!==undefined)node.textContent=text;return node;};
  const area=make('div'),legend=make('small'),list=make('div');area.className='ms-preview-list';area.dataset.sourcePreviewList='';area.hidden=true;list.className='ms-preview-items';
  legend.textContent='최근 메시지 · 취소선은 분석에서 빠지는 부분입니다.';area.append(legend,list);host.append(area);
  let samples=null,serial=0;
  const render=async()=>{
    if(!samples)return;const token=++serial;
    let rules=null;try{rules=config.draft();}catch{}
    const legacy=config.legacy?.()===true&&typeof config.projectLegacy==='function';
    legend.textContent=legacy?'최근 메시지 · 아직 저장한 규칙이 없어 플러그인 자체 정리 결과를 보여 줍니다. 규칙을 바꾸면 빠지는 부분이 취소선으로 표시됩니다.':'최근 메시지 · 취소선은 분석에서 빠지는 부분입니다.';
    const cards=[];
    for(const [n,item] of samples.entries()){
      const card=make('article'),head=make('div'),pre=make('pre');card.className='ms-preview-item';card.dataset.sourcePreviewItem=String(n);head.className='ms-preview-head';
      head.append(make('strong',(samples.length-n===1?'마지막 메시지':'최근 '+(samples.length-n)+'번째 메시지')+(item.role?' · '+({user:'사용자',assistant:'응답',char:'응답',model:'응답'}[item.role]||item.role):'')));
      if(legacy){
        let text='';try{text=String(await config.projectLegacy(item)??'').replace(/\r\n/g,'\n').trim();}catch{text='';}
        pre.textContent=text||'(분석할 내용 없음)';
      }else if(rules){
        const marked=memorySuiteMarkSourceProjection(item.text,rules);
        if(marked.exact){
          for(const segment of marked.segments){const node=segment.removed?make('del',segment.text):doc.createTextNode(segment.text);pre.append(node);}
          const removed=marked.segments.filter(segment=>segment.removed).reduce((sum,segment)=>sum+segment.text.length,0);
          head.append(make('small',removed?removed.toLocaleString('ko-KR')+'자 빠짐':'빠지는 부분 없음'));
        }else{pre.textContent=memorySuiteProjectSourceRules(memorySuiteStripInternalSource(item.text),rules).text.replace(/\r\n/g,'\n').trim();head.append(make('small','분석 입력 (빠진 부분 표시 불가)'));}
        if(marked.fallback)card.dataset.sourcePreviewWarning='';
      }else{pre.textContent=item.text;head.append(make('small','규칙 초안에 오류가 있어 원문 그대로 표시'));}
      card.append(head,pre);cards.push(card);
      if(token!==serial)return;
    }
    if(token!==serial)return;
    list.replaceChildren(...cards);area.hidden=!cards.length;
  };
  const load=async()=>{
    const token=++serial;
    try{const items=memorySuiteSourceSampleItems(await config.readSamples());if(token!==serial)return;samples=items.slice(-5);}
    catch{samples=null;area.hidden=true;return;}
    await render();
  };
  return {load,refresh:()=>{void render();}};
}
// 세 플러그인 동시 적용: LIBRA, HAYAKU and Flashback keep their own copies of the source rules
// and compare or copy them over plugin IPC. Only the three suite plugins may ask, the request
// carries normalized rules only, and each receiver saves through its own policy (busy and
// internal-rule checks included). Nothing else is exchanged.
const MEMORY_SUITE_SOURCE_RULE_SYNC_CHANNEL='memory_suite_source_rules_v1';
const MEMORY_SUITE_SOURCE_RULE_SYNC_SCHEMA='memory-suite.source-rules-sync.v1';
const MEMORY_SUITE_SOURCE_RULE_PEERS=Object.freeze({libra:'libra',hayaku:'hayaku_locator_continuity',flashback:'flashback_memory'});
const MEMORY_SUITE_SOURCE_RULE_LABELS=Object.freeze({libra:'LIBRA',hayaku:'HAYAKU',flashback:'Flashback'});
function createMemorySuiteSourceRuleSync(config) {
  const owner=config.owner,self=MEMORY_SUITE_SOURCE_RULE_PEERS[owner];
  if(!self)throw Error('SOURCE_RULE_SYNC_OWNER_INVALID');
  const peers=Object.keys(MEMORY_SUITE_SOURCE_RULE_PEERS).filter(key=>key!==owner);
  const pending=new Map();let started=false,starting=null,disposed=false,serial=0;
  const api=()=>{try{return config.api();}catch{return null;}};
  const fingerprint=rules=>rules?JSON.stringify(memorySuiteNormalizeSourceRules(rules)):'';
  const reply=(target,message,result,error)=>Promise.resolve(api()?.postPluginChannelMessage(target,MEMORY_SUITE_SOURCE_RULE_SYNC_CHANNEL,{schema:MEMORY_SUITE_SOURCE_RULE_SYNC_SCHEMA,kind:'response',id:message.id,action:message.action,...(error?{error}:{result})})).catch(()=>{});
  const handler=async(message,metadata={})=>{
    if(disposed||!message||typeof message!=='object'||message.schema!==MEMORY_SUITE_SOURCE_RULE_SYNC_SCHEMA||typeof message.id!=='string'||message.id.length>160)return;
    const sender=String(metadata?.sender||'');
    if(!Object.values(MEMORY_SUITE_SOURCE_RULE_PEERS).includes(sender)||sender===self)return;
    if(message.kind==='response'){const record=pending.get(message.id);if(!record||record.target!==sender)return;pending.delete(message.id);clearTimeout(record.timer);record.resolve(message.error?{ok:false,error:String(message.error)}:{ok:true,result:message.result||{}});return;}
    if(message.kind!=='request')return;
    try{
      await config.policy.ready();
      if(message.action==='describe')return void reply(sender,message,{owner,rules:memorySuiteSourceRules(owner)||null});
      if(message.action==='apply'){
        if(config.isDisposed?.()===true)throw Error('SOURCE_RULE_SYNC_DISPOSED');
        const rules=memorySuiteNormalizeSourceRules(message.rules);
        await config.policy.setSourceRules(rules);
        config.onRemoteApply?.(rules);
        return void reply(sender,message,{owner,applied:true,rules:memorySuiteSourceRules(owner)||null});
      }
      throw Error('SOURCE_RULE_SYNC_ACTION_INVALID');
    }catch(error){reply(sender,message,null,String(error?.message||error).slice(0,300));}
  };
  const start=()=>{
    if(started||disposed)return Promise.resolve(started);
    if(!starting)starting=(async()=>{const host=api();if(typeof host?.addPluginChannelListener!=='function'||typeof host?.postPluginChannelMessage!=='function')return false;
      if(await host.addPluginChannelListener(MEMORY_SUITE_SOURCE_RULE_SYNC_CHANNEL,handler)===false)return false;started=true;return true;})().catch(()=>false).finally(()=>{starting=null;});
    return starting;
  };
  const ask=async(peer,action,body={},timeoutMs=3000)=>{
    if(!await start())return {ok:false,error:'SOURCE_RULE_SYNC_IPC_UNAVAILABLE'};
    const id=self+':'+Date.now().toString(36)+':'+(++serial),target=MEMORY_SUITE_SOURCE_RULE_PEERS[peer];
    return await new Promise(resolve=>{
      const record={target,resolve,timer:setTimeout(()=>{pending.delete(id);resolve({ok:false,error:'SOURCE_RULE_SYNC_TIMEOUT'});},timeoutMs)};
      pending.set(id,record);
      Promise.resolve(api()?.postPluginChannelMessage(target,MEMORY_SUITE_SOURCE_RULE_SYNC_CHANNEL,{schema:MEMORY_SUITE_SOURCE_RULE_SYNC_SCHEMA,kind:'request',id,action,...body}))
        .catch(()=>{if(pending.delete(id)){clearTimeout(record.timer);resolve({ok:false,error:'SOURCE_RULE_SYNC_IPC_UNAVAILABLE'});}});
    });
  };
  // state per peer: same | different | built_in (no saved rules there) | absent (no answer).
  const compare=async()=>{
    await config.policy.ready();const mine=fingerprint(memorySuiteSourceRules(owner));
    const answers=await Promise.all(peers.map(async peer=>{const answer=await ask(peer,'describe');
      if(!answer.ok)return [peer,{state:answer.error==='SOURCE_RULE_SYNC_TIMEOUT'||answer.error==='SOURCE_RULE_SYNC_IPC_UNAVAILABLE'?'absent':'error',error:answer.error}];
      const theirs=answer.result?.rules?fingerprint(answer.result.rules):'';
      return [peer,{state:!theirs?(mine?'built_in':'same'):theirs===mine?'same':'different'}];}));
    return Object.fromEntries(answers);
  };
  const applyToPeers=async(rules,only=peers)=>{
    const normalized=memorySuiteNormalizeSourceRules(rules);
    const answers=await Promise.all(only.filter(peer=>peers.includes(peer)).map(async peer=>[peer,await ask(peer,'apply',{rules:normalized},6000)]));
    return Object.fromEntries(answers.map(([peer,answer])=>[peer,answer.ok?{ok:true}:{ok:false,error:answer.error}]));
  };
  const dispose=async()=>{disposed=true;for(const record of pending.values())clearTimeout(record.timer);pending.clear();
    if(started){started=false;try{await api()?.removePluginChannelListener?.(MEMORY_SUITE_SOURCE_RULE_SYNC_CHANNEL,handler);}catch{}}};
  return Object.freeze({owner,peers,start,compare,applyToPeers,dispose});
}
// The editor's view of the other two plugins: whether their rules match, and one action to copy
// this plugin's saved rules to them. Applying here with the box checked does the same.
function mountMemorySuiteSourceRuleSyncPanel(host, config) {
  const doc=host.ownerDocument,make=(tag,text)=>{const node=doc.createElement(tag);if(text!==undefined)node.textContent=text;return node;};
  const area=make('section'),title=make('strong','다른 기억 플러그인'),list=make('div'),actions=make('div'),copy=make('button','이 규칙을 다른 플러그인에도 적용'),recheck=make('button','다시 확인'),status=make('p');
  const together=make('label'),box=make('input');box.type='checkbox';box.checked=true;box.dataset.sourceRuleSyncTogether='';together.className='ms-sync-together';together.append(box,make('span','적용할 때 다른 기억 플러그인에도 같은 규칙 적용'));
  area.className='ms-input-sync';area.dataset.sourceRuleSync='';list.className='ms-sync-list';list.dataset.sourceRuleSyncList='';actions.className='ms-sync-actions';
  copy.type=recheck.type='button';copy.dataset.sourceRuleSyncCopy='';recheck.dataset.sourceRuleSyncRecheck='';status.dataset.sourceRuleSyncStatus='';status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  actions.append(copy,recheck);area.append(title,together,list,actions,status);host.append(area);
  const stateLabels={same:'같은 규칙',different:'규칙이 다름',built_in:'규칙 저장 안 함 · 자체 정리 사용',absent:'응답 없음 (꺼져 있거나 설치되지 않음)',error:'확인 실패',checking:'확인 중…'};
  let states={},busy=false;
  const draw=()=>{
    list.replaceChildren(...config.sync.peers.map(peer=>{const row=make('div'),name=make('b',MEMORY_SUITE_SOURCE_RULE_LABELS[peer]),state=make('span',stateLabels[states[peer]?.state||'checking']);
      row.className='ms-sync-row';row.dataset.sourceRuleSyncPeer=peer;row.dataset.state=states[peer]?.state||'checking';row.append(name,state);return row;}));
    const reachable=config.sync.peers.filter(peer=>['different','built_in'].includes(states[peer]?.state));
    copy.disabled=busy||config.busy?.()===true||!config.savedRules()||config.dirty?.()===true||!reachable.length;
    recheck.disabled=busy;
  };
  const check=async()=>{busy=true;states={};draw();try{states=await config.sync.compare();}catch{states={};}finally{busy=false;draw();}};
  const sendTo=async(rules,peers)=>{
    busy=true;draw();status.textContent='다른 플러그인에 적용 중…';
    try{
      const results=await config.sync.applyToPeers(rules,peers);
      const parts=Object.entries(results).map(([peer,result])=>MEMORY_SUITE_SOURCE_RULE_LABELS[peer]+(result.ok?' 적용됨':' 실패('+(/BUSY/.test(result.error||'')?'처리 중이라 저장하지 못함':/TIMEOUT|UNAVAILABLE/.test(result.error||'')?'응답 없음':result.error)+')'));
      status.textContent=parts.length?parts.join(' · '):'적용할 플러그인이 없습니다.';
    }finally{busy=false;await check();}
  };
  copy.onclick=()=>{const rules=config.savedRules();if(!rules||busy)return;void sendTo(rules,config.sync.peers.filter(peer=>['different','built_in'].includes(states[peer]?.state)));};
  recheck.onclick=()=>{if(!busy)void check();};
  // Called by the editor after its own 적용 succeeded.
  const afterApply=async rules=>{if(!box.checked){await check();return;}const targets=config.sync.peers.filter(peer=>states[peer]?.state!=='absent');await sendTo(rules,targets);};
  return {check,afterApply,refresh:draw};
}
function mountMemorySuiteSourceInputControls(container, config) {
    const {owner,policy}=config,loadPreferences=()=>policy.ready(),sourceRules=()=>policy.sourceRules(),setSourceRules=rules=>policy.setSourceRules(rules);
    const disposed=()=>config.isDisposed?.()===true;
    const preferences={get sourceRules(){return memorySuiteSourceRules(owner);}};
    if(!container?.ownerDocument||container.querySelector('[data-source-input-controls]'))return;
    const doc=container.ownerDocument,box=doc.createElement('section');
    box.dataset.sourceInputControls=owner;box.className='ms-source-settings';container.prepend(box);
    const make=(tag,text)=>{const node=doc.createElement(tag);if(text!==undefined)node.textContent=text;return node;};
    const style=make('style');style.textContent=`
.ms-source-settings{display:grid;gap:12px;width:100%;min-width:0;color:inherit;font:inherit;font-size:var(--fs-body,13px);line-height:1.55}
.ms-source-settings *{box-sizing:border-box}.ms-source-settings p,.ms-source-settings h3{margin:0}.ms-source-settings h3{font-size:15px}.ms-source-settings label{display:grid;gap:5px;font-size:12.5px}.ms-source-settings small{opacity:.8}
.ms-source-settings button,.ms-source-settings input,.ms-source-settings textarea,.ms-source-settings select{font:inherit;font-size:13px;color:inherit;border:1px solid var(--border2,#8887);border-radius:var(--r-sm,8px);background:var(--input-bg,var(--surface,transparent));min-width:0;min-height:38px;padding:7px 10px}.ms-source-settings textarea{width:100%;resize:vertical;line-height:1.5}.ms-source-settings button{cursor:pointer;padding:7px 14px;font-weight:650;background:var(--surface,transparent)}.ms-source-settings button:hover:not(:disabled){background:var(--surface3,#8881)}.ms-source-settings button:disabled{opacity:.5;cursor:default}.ms-source-settings :is(button,input,textarea,select):focus-visible{outline:2px solid var(--accent,currentColor);outline-offset:1px}
.ms-source-settings [hidden]{display:none!important}.ms-source-settings .ms-sr-only{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.ms-source-settings .ms-input-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:10px 12px;border:1px solid var(--border,#8884);border-radius:var(--r-md,11px);background:var(--surface2,transparent)}.ms-source-settings .ms-input-toolbar .ms-input-apply{margin-right:auto;min-width:88px}
.ms-source-settings .ms-input-apply{background:var(--accent,#79522d);color:var(--on-accent,#fff);border-color:var(--accent,#79522d)}.ms-source-settings .ms-input-apply:hover:not(:disabled){background:var(--accent-hover,var(--accent,#79522d))}
.ms-source-settings .ms-input-status:empty{display:none}.ms-source-settings .ms-input-status{font-weight:650}.ms-source-settings .ms-input-hint{font-size:12px;color:var(--text2,inherit)}
.ms-source-settings .ms-input-head,.ms-source-settings .ms-input-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(128px,160px) 110px 62px;gap:8px;align-items:center}
.ms-source-settings .ms-input-head{padding:0 11px;font-size:11.5px;font-weight:700;color:var(--text3,inherit)}
.ms-source-settings .ms-input-list{display:grid;gap:6px}.ms-source-settings .ms-input-row{padding:8px 10px;border:1px solid var(--border,#8884);border-radius:var(--r-md,11px);background:var(--surface,transparent)}
.ms-source-settings .ms-input-row textarea{min-height:38px;height:38px;white-space:nowrap;overflow-x:auto;overflow-y:hidden;scrollbar-width:none;resize:none}.ms-source-settings .ms-input-row select{width:100%}.ms-source-settings .ms-input-row [data-rule-delete]{padding:7px 8px}
.ms-source-settings .ms-input-fields{display:grid;gap:4px;min-width:0}.ms-source-settings .ms-custom-toggle{display:flex;align-items:center;gap:6px;font-size:12px;white-space:nowrap;cursor:pointer}.ms-source-settings .ms-custom-toggle input{margin:0;min-height:0;width:16px;height:16px;accent-color:var(--accent,currentColor)}.ms-source-settings .ms-custom-fields{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.ms-source-settings .ms-input-chip{justify-self:start;padding:0 8px;border:1px solid var(--border2,#8886);border-radius:99px;font-size:11px;opacity:1;color:var(--text2,inherit)}
.ms-source-settings .ms-input-preview{border-top:1px solid var(--border,#8885);padding-top:12px;display:grid;gap:8px}.ms-source-settings .ms-input-preview>button{justify-self:start}.ms-source-settings pre{font:12.5px/1.6 var(--font-mono,ui-monospace,monospace);white-space:pre-wrap;overflow-wrap:anywhere;border:1px solid var(--border,#8885);border-radius:var(--r-sm,8px);background:var(--surface2,transparent);padding:12px;max-height:360px;overflow:auto;margin:0}.ms-source-settings .ms-input-warning{border-left:3px solid var(--warn,#b9802e);padding-left:10px}.ms-source-settings details{font-size:12.5px}.ms-source-settings summary{cursor:pointer}
@media(max-width:600px){.ms-source-settings .ms-input-head{display:none}.ms-source-settings .ms-input-row{grid-template-columns:minmax(0,1fr) auto auto}.ms-source-settings .ms-input-fields{grid-column:1/-1}.ms-source-settings .ms-custom-fields{grid-template-columns:1fr}.ms-source-settings .ms-input-toolbar{display:grid;grid-template-columns:1fr 1fr}.ms-source-settings .ms-input-toolbar button{white-space:nowrap;padding:7px 8px}.ms-source-settings .ms-input-toolbar .ms-input-apply{margin-right:0}}
`;
    const toolbar=make('div'),apply=make('button','적용'),add=make('button','태그 추가'),undo=make('button','삭제 되돌리기'),defaults=make('button','기본 규칙 복원'),status=make('p');
    toolbar.className='ms-input-toolbar';apply.className='ms-input-apply';apply.dataset.sourceInputApply='';
    for(const button of [apply,add,undo,defaults]){button.type='button';button.disabled=true;}
    add.dataset.sourceInputAdd='';undo.dataset.sourceInputUndo='';defaults.dataset.sourceInputDefaults='';toolbar.append(apply,add,undo,defaults);
    status.dataset.sourceInputStatus='';status.className='ms-input-status';status.setAttribute('role','status');status.setAttribute('aria-live','polite');
    const hint=make('p','저장된 태그 규칙을 확인·편집합니다. 적용을 눌러야 저장되며 기본 규칙 복원도 초안만 바꿉니다. 알 수 없는 외부 태그는 그대로 두고, 기존 기억은 유지됩니다. 바꾸려면 원하는 구간을 직접 재분석하세요.');hint.className='ms-input-hint';
    const head=make('div');head.className='ms-input-head';head.setAttribute('aria-hidden','true');head.append(make('span','태그 이름 · XML 예시 · 표식'),make('span','처리 방법'),make('span','직접 구분자'),make('span'));
    const list=make('div');list.dataset.sourceInputList='';list.className='ms-input-list';
    const noticeHost=make('div'),finderHost=make('div'),syncHost=make('div'),previewListHost=make('div');
    box.append(style,toolbar,status,noticeHost,syncHost,hint,head,list);
    const previewArea=make('section'),previewButton=make('button','현재 채팅 미리보기'),previewStatus=make('p'),warning=make('p'),output=make('pre');
    previewArea.className='ms-input-preview';previewButton.type='button';previewButton.dataset.sourceInputPreview='';previewButton.disabled=true;
    previewStatus.dataset.sourceInputPreviewStatus='';previewStatus.setAttribute('role','status');previewStatus.setAttribute('aria-live','polite');
    warning.dataset.sourceInputWarning='';warning.className='ms-input-warning';warning.setAttribute('role','alert');warning.hidden=true;
    output.dataset.sourceInputOutput='';output.hidden=true;output.setAttribute('aria-label','실제 분석 입력 미리보기');
    previewArea.append(previewButton,make('small','현재 채팅에서 불러온 메시지를 기준으로 실제 분석 입력을 보여 줍니다. AI를 호출하지 않으며 미리보기 본문을 저장하거나 로그에 남기지 않습니다.'),previewStatus,warning,output,previewListHost);box.append(finderHost,previewArea);
    const help=make('details'),summary=make('summary','규칙 사용 방법');help.append(summary,make('p','태그 이름(예: original), 여는 태그 또는 XML 예시를 붙여 넣으세요. 표준 태그는 닫는 태그를 자동으로 찾습니다. 일반 표식은 직접 구분자를 켜고 여는 표식과 닫는 표식을 입력하세요. 내용 전체 제외 → 태그와 내용 제거, 태그만 제거 → 안의 내용 유지, 이 안만 분석 → 바깥 내용 제외입니다. 적용 순서는 이 안만 분석, 내용 전체 제외, 태그만 제거입니다. 선택 영역이 비어 있거나 불완전·중복이면 전체 본문을 사용하며 미리보기에 경고합니다. Suite 자체 운용 표식은 내부에서 처리합니다.'));box.append(help);
    const controlLabels={'html-comment':'HTML 주석','lbdata':'LBDATA 제어 블록','inlay':'삽화 호출'};
    const actionNames={ignoredTags:'내용 전체 제외',unwrapTags:'태그만 제거',sourceTags:'이 안만 분석'};
    let rows=[],removed=[],loaded=false,applying=false,initial='',legacy=false,sample=null,previewVersion=0,readingSample=false;
    const isEmpty=row=>row.custom.checked?!row.open.value.trim()&&!row.close.value.trim():!row.value.value.trim();
    function inferTag(input) {
      const value=input.trim();
      if(/^[a-z][a-z0-9:_-]{0,63}$/i.test(value))return value.toLowerCase();
      const tag=/^<([a-z][a-z0-9:_-]{0,63})(?=[\s/>])(?:"[^"]*"|'[^']*'|[^'">])*?>/i.exec(value);
      if(tag){const rest=value.slice(tag[0].length);if(!rest.trim()||new RegExp('</'+tag[1]+'\\s*>$','i').test(rest))return tag[1].toLowerCase();}
      throw Error('태그 이름 또는 짝이 맞는 XML 예시를 입력하세요. 일반 표식은 직접 구분자를 켜 주세요.');
    }
    function readDraft() {
      const draft={version:1,ignoredTags:[],unwrapTags:[],sourceTags:[],controls:[]};
      for(const row of rows){
        if(isEmpty(row))continue;
        const key=row.action.value;
        if(row.custom.checked){
          const entry={open:row.open.value,close:row.close.value};
          const form=row.control&&memorySuiteSourceRuleForm('@'+row.control);
          if(form&&key==='ignoredTags'&&entry.open===form.open&&entry.close===form.close)draft.controls.push(row.control);
          else draft[key].push(entry);
        }else draft[key].push(inferTag(row.value.value));
      }
      return memorySuiteNormalizeSourceRules(draft);
    }
    const fingerprint=rules=>JSON.stringify(memorySuiteNormalizeSourceRules(rules));
    function setEnabled() {
      for(const row of rows){for(const node of row.element.querySelectorAll('input,textarea,select,button'))node.disabled=!loaded||applying;row.remove.disabled=!loaded||applying||isEmpty(row);}
      let dirty=true;try{dirty=fingerprint(readDraft())!==initial;}catch{}
      apply.disabled=!loaded||applying||!dirty;
      add.disabled=defaults.disabled=!loaded||applying;undo.disabled=!loaded||applying||!removed.length;
      previewButton.disabled=!loaded||applying||readingSample||typeof config.readSample!=='function';
    }
    async function showPreview() {
      if(!sample)return;
      const version=++previewVersion;
      warning.hidden=true;warning.textContent='';output.textContent='';output.hidden=true;
      try{
        const rules=readDraft();let projected;
        if(legacy&&fingerprint(rules)===initial){
          if(typeof config.projectLegacySample!=='function'){previewStatus.textContent='기본 분석 입력을 미리 볼 수 없습니다.';return;}
          projected={text:await config.projectLegacySample(sample),warnings:[]};
        }else projected=memorySuiteProjectSourceRules(memorySuiteStripInternalSource(sample.text),rules);
        if(disposed()||version!==previewVersion)return;
        output.textContent=String(projected.text??'').replace(/\r\n/g,'\n').trim();output.hidden=false;
        warning.textContent=projected.warnings.join(' ');warning.hidden=!projected.warnings.length;
        previewStatus.textContent=(sample.label?sample.label+' · ':'')+(output.textContent?'불러온 메시지의 분석 입력':'분석할 내용이 없습니다.')+(fingerprint(rules)!==initial?' · 아직 적용하지 않은 규칙':'');
      }catch(e){if(disposed()||version!==previewVersion)return;warning.textContent=String(e.message||e);warning.hidden=false;previewStatus.textContent='규칙을 확인한 뒤 다시 미리 보세요.';}
    }
    function changed() {
      if(!loaded||applying)return;
      if(!rows.some(isEmpty))addRow();
      status.textContent='변경한 규칙을 적용해 주세요.';setEnabled();void showPreview();finder?.refresh();previewList.refresh();syncPanel?.refresh();
    }
    // A rule chosen in the finder or the defaults notice lands in the draft; 적용 still saves it.
    function addFoundRule(name,key) {
      if(!loaded||applying)return;
      for(const row of rows.filter(isEmpty))row.element.remove();rows=rows.filter(row=>!isEmpty(row));
      if(name.startsWith('@'))addRow(memorySuiteSourceRuleForm(name),'ignoredTags',name.slice(1));else addRow(name,key);
      changed();
    }
    const draftOrNull=()=>{try{return readDraft();}catch{return null;}};
    const finder=mountMemorySuiteSourceTagFinder(finderHost,{draft:readDraft,addRule:addFoundRule,busy:()=>!loaded||applying,
      readSamples:async()=>typeof config.readSamples==='function'?await config.readSamples():[(await config.readSample?.())?.text].filter(value=>typeof value==='string')});
    const missingNotice=mountMemorySuiteMissingDefaultsNotice(noticeHost,{owner,draft:draftOrNull,addRule:addFoundRule,busy:()=>!loaded||applying});
    const draftUnchanged=()=>{try{return fingerprint(readDraft())===initial;}catch{return false;}};
    // Recent messages with removed parts struck through; before any saved rule, the plugin's own cleanup.
    const previewList=mountMemorySuiteSourcePreviewList(previewListHost,{draft:readDraft,legacy:()=>legacy&&draftUnchanged(),projectLegacy:item=>config.projectLegacySample?.(item),
      readSamples:async()=>typeof config.readSamples==='function'?await config.readSamples():[]});
    const syncPanel=config.ruleSync?mountMemorySuiteSourceRuleSyncPanel(syncHost,{sync:config.ruleSync,savedRules:()=>memorySuiteSourceRules(owner),dirty:()=>!draftUnchanged(),busy:()=>!loaded||applying}):null;
    function addRow(value=null,key='ignoredTags',control=null) {
      const hidden=text=>{const span=make('span',text);span.className='ms-sr-only';return span;};
      const element=make('div'),fields=make('div'),tagLabel=make('label'),valueInput=make('textarea'),customLabel=make('label'),custom=make('input'),customFields=make('div'),open=make('input'),close=make('input'),actionLabel=make('label'),action=make('select'),remove=make('button','삭제');
      element.dataset.sourceInputRow='';element.className='ms-input-row';fields.className='ms-input-fields';tagLabel.dataset.ruleTagLabel='';
      valueInput.dataset.ruleValue='';valueInput.rows=1;valueInput.placeholder='예: decoration 또는 <decoration>예시</decoration>';tagLabel.append(hidden('태그 이름 또는 XML 예시'),valueInput);
      custom.type='checkbox';custom.dataset.ruleCustom='';customLabel.className='ms-custom-toggle';customLabel.append(custom,make('span','직접 구분자'));
      customFields.className='ms-custom-fields';open.dataset.ruleOpen='';close.dataset.ruleClose='';open.type=close.type='text';open.maxLength=close.maxLength=256;open.placeholder='여는 표식 예: [START]';close.placeholder='닫는 표식 예: [END]';
      const openLabel=make('label'),closeLabel=make('label');openLabel.append(hidden('여는 표식'),open);closeLabel.append(hidden('닫는 표식'),close);customFields.append(openLabel,closeLabel);
      for(const [optionValue,label]of Object.entries(actionNames)){const option=make('option',label);option.value=optionValue;action.append(option);}action.value=key;action.dataset.ruleAction='';actionLabel.append(hidden('처리 방법'),action);
      remove.type='button';remove.dataset.ruleDelete='';remove.setAttribute('aria-label','이 규칙 삭제');
      if(value&&typeof value==='object'){custom.checked=true;open.value=value.open;close.value=value.close;}else if(value)valueInput.value=value;
      const row={element,value:valueInput,custom,open,close,action,remove,control};rows.push(row);
      const syncMode=()=>{tagLabel.hidden=custom.checked;customFields.hidden=!custom.checked;};syncMode();
      custom.onchange=()=>{
        if(custom.checked&&!open.value&&!close.value&&valueInput.value.trim()){
          try{const name=inferTag(valueInput.value);open.value='<'+name+'>';close.value='</'+name+'>';}catch{open.value=valueInput.value;}
        }
        if(!custom.checked&&(open.value||close.value))valueInput.value=open.value||close.value;
        syncMode();changed();
      };valueInput.oninput=open.oninput=close.oninput=changed;action.onchange=changed;
      remove.onclick=()=>{if(!loaded||applying||isEmpty(row))return;removed.push({row,index:rows.indexOf(row)});if(removed.length>128)removed.shift();rows=rows.filter(item=>item!==row);element.remove();changed();};
      fields.append(tagLabel,customFields);if(control){const chip=make('small',controlLabels[control]||'저장된 기본 규칙');chip.className='ms-input-chip';fields.append(chip);}
      element.append(fields,actionLabel,customLabel,remove);list.append(element);return row;
    }
    function fill(rules=sourceRules(),resetInitial=true) {
      rows=[];removed=[];list.replaceChildren();
      for(const key of Object.keys(actionNames))for(const entry of rules[key])addRow(entry,key);
      for(const control of rules.controls)addRow(memorySuiteSourceRuleForm('@'+control),'ignoredTags',control);
      addRow();if(resetInitial){initial=fingerprint(rules);legacy=!preferences.sourceRules;missingNotice.update(preferences.sourceRules);}setEnabled();finder?.refresh();
    }
    add.onclick=()=>{if(!loaded||applying||disposed())return;const row=rows.find(isEmpty)||addRow();row.element.scrollIntoView?.({block:'nearest'});row.value.focus();};
    undo.onclick=()=>{if(!loaded||applying||disposed())return;const entry=removed.pop();if(!entry)return;const index=Math.min(entry.index,rows.length);list.insertBefore(entry.row.element,rows[index]?.element||null);rows.splice(index,0,entry.row);changed();status.textContent='삭제한 규칙을 되돌렸습니다. 적용 전입니다.';};
    defaults.onclick=()=>{if(!loaded||applying||disposed())return;fill({...memorySuiteDefaultSourceRules(owner),ignoredTags:[...new Set([...memorySuiteSourceIgnoredTags(),'thoughts',...memorySuiteDefaultPresentationTags(owner)])].sort()},false);changed();status.textContent='기본 규칙을 복원한 초안입니다. 적용을 눌러야 저장됩니다.';};
    apply.onclick=async()=>{
      if(!loaded||applying||disposed())return;
      let rules;try{rules=readDraft();if(fingerprint(rules)===initial)return;}catch(e){status.textContent='적용 실패: '+String(e.message||e);return;}
      applying=true;status.textContent='적용 중…';setEnabled();
      try{await setSourceRules(rules);if(disposed())return;fill();status.textContent='규칙을 적용했습니다. 기존 기억은 유지됩니다.';await showPreview();previewList.refresh();void syncPanel?.afterApply(memorySuiteSourceRules(owner));}
      catch(e){if(!disposed())status.textContent='적용 실패: '+String(e.message||e);}
      finally{applying=false;if(!disposed())setEnabled();}
    };
    previewButton.onclick=async()=>{
      if(!loaded||readingSample||disposed()||typeof config.readSample!=='function')return;
      readingSample=true;sample=null;void previewList.load();const version=++previewVersion;output.textContent='';output.hidden=true;warning.textContent='';warning.hidden=true;previewStatus.textContent='현재 채팅을 읽는 중…';setEnabled();
      try{
        const result=await config.readSample();if(disposed()||version!==previewVersion)return;
        if(result==null){previewStatus.textContent='현재 채팅에 미리 볼 메시지가 없습니다.';return;}
        if(typeof result!=='string'&&typeof result.text!=='string')throw Error('SOURCE_SAMPLE_INVALID');
        sample=typeof result==='string'?{text:result}:result;await showPreview();
      }catch{if(!disposed()&&version===previewVersion)previewStatus.textContent='현재 채팅을 읽지 못했습니다. 잠시 뒤 다시 미리 보세요.';}
      finally{readingSample=false;if(!disposed())setEnabled();}
    };
    status.textContent='저장된 규칙을 읽는 중…';
    loadPreferences().then(()=>{if(disposed())return;loaded=true;fill();status.textContent='';void syncPanel?.check();if(typeof config.readSample!=='function')previewStatus.textContent='현재 채팅 미리보기를 사용할 수 없습니다.';}).catch(()=>{if(!disposed())status.textContent='저장된 규칙을 읽지 못했습니다. 설정을 다시 열어 주세요.';});
  }

function memorySuiteReanalysisGridCss(){return `
.ms-reanalysis-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(168px,1fr));grid-auto-flow:row dense;gap:10px;min-width:0}
.ms-reanalysis-turn--compact{display:flex;flex-direction:column;gap:5px;aspect-ratio:1/1;min-width:0;min-height:0;padding:12px;border:1px solid var(--border,#8885);border-radius:var(--r-md,12px);background:var(--surface,transparent);overflow:hidden;overflow-wrap:anywhere;cursor:pointer;transition:border-color .16s,box-shadow .16s,background .16s}
.ms-reanalysis-turn--compact:hover{border-color:var(--border2,#8889)}
.ms-reanalysis-turn--compact:has(>label input:checked){border-color:var(--accent,#79522d);box-shadow:inset 0 0 0 1px var(--accent,#79522d);background:var(--accent-soft,var(--surface,transparent))}
.ms-reanalysis-turn--compact:has(>label input:disabled){cursor:default;opacity:.75}
.ms-reanalysis-turn--compact>label{display:flex;align-items:flex-start;gap:8px;min-width:0;cursor:pointer}
.ms-reanalysis-turn--compact>label input{flex:none;width:17px;height:17px;margin:1px 0 0;accent-color:var(--accent,#79522d)}
.ms-reanalysis-turn--compact>label strong{min-width:0;font-size:14px;line-height:1.35;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2}
.ms-reanalysis-turn--compact .ms-turn-meta{margin:0;font-size:11.5px;line-height:1.45;color:var(--text3,inherit);overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2}
.ms-reanalysis-turn--compact .ms-turn-eyebrow{font-size:11px;font-weight:700;color:var(--text3,inherit);letter-spacing:.02em}
.ms-reanalysis-turn--compact .ms-turn-summary{flex:0 1 auto;min-height:0;margin:0;font-size:12.5px;line-height:1.55;color:var(--text2,inherit);overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:5}
.ms-reanalysis-turn--compact>details{margin-top:auto;font-size:12px}
.ms-reanalysis-turn--compact>details>summary{cursor:pointer;color:var(--text2,inherit);font-weight:650}
.ms-reanalysis-turn--compact pre{margin:8px 0 0;padding:10px 12px;max-height:360px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;border:1px solid var(--border,#8885);border-radius:var(--r-sm,8px);background:var(--surface2,transparent);font:12px/1.6 var(--font-mono,ui-monospace,monospace)}
.ms-reanalysis-turn--compact.is-open{grid-column:1/-1;aspect-ratio:auto;cursor:default}
.ms-reanalysis-turn--compact.is-open .ms-turn-summary{display:block;white-space:pre-wrap}
@media(max-width:600px){.ms-reanalysis-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.ms-reanalysis-turn--compact{padding:10px}.ms-reanalysis-turn--compact .ms-turn-summary{-webkit-line-clamp:4}}
`;}
// One card per turn keeps checkboxes aligned and allows source inspection without dispatch.
function appendMemorySuiteReanalysisRange(list,range,config) {
  const doc=list.ownerDocument,make=(tag,text)=>{const n=doc.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
  const row=make('section'),label=make('label'),input=make('input'),details=make('details'),summary=make('summary','원문 보기'),output=make('pre');
  input.type='checkbox';input.value=range.key;input.setAttribute('aria-label',range.label+' 재분석 선택');input.onchange=config.changed;
  if(config.compact){
    // Square cards: many turns per screen; opening the source widens the card to a full row.
    const host=list.getRootNode?.()?.head||list.getRootNode?.();
    if(host?.querySelector&&!host.querySelector('style[data-ms-reanalysis-grid]')){const style=make('style');style.dataset.msReanalysisGrid='';style.textContent=memorySuiteReanalysisGridCss();host.append(style);}
    row.className='ms-reanalysis-turn ms-reanalysis-turn--compact';
    const title=make('strong',range.label);title.title=range.label;label.append(input,title);row.append(label);
    if(range.description){const description=make('p',range.description);description.className='ms-turn-meta';description.title=range.description;row.append(description);}
    if(range.summary){const eyebrow=make('small','저장된 내용'),excerpt=make('p',range.summary);eyebrow.className='ms-turn-eyebrow';excerpt.className='ms-turn-summary';excerpt.title=range.summary;row.append(eyebrow,excerpt);}
    row.onclick=event=>{if(!event.target.closest?.('label,details,button,a')&&!input.disabled)input.click();};
  }else{
    row.className='ms-reanalysis-turn';row.style.cssText='display:grid;gap:8px;padding:14px;border:1px solid #8885;border-radius:12px;min-width:0';
    label.style.cssText='display:flex;align-items:center;gap:10px';
    label.append(input,make('strong',range.label));row.append(label);
    if(range.description){const description=make('p',range.description);description.style.cssText='margin:0;white-space:pre-wrap;overflow-wrap:anywhere';row.append(description);}
    if(range.summary){const excerpt=make('p','저장된 내용 · '+range.summary);excerpt.style.cssText='margin:0;white-space:pre-wrap;overflow-wrap:anywhere';row.append(excerpt);}
    output.style.cssText='white-space:pre-wrap;overflow-wrap:anywhere;max-height:360px;overflow:auto';
  }
  details.append(summary,output);row.append(details);list.append(row);
  let serial=0;
  details.ontoggle=async()=>{
    if(config.compact)row.classList.toggle('is-open',details.open);
    if(!details.open){serial++;return;}
    const token=++serial;output.textContent='원문을 읽는 중…';
    try{const sample=await config.read();if(!row.isConnected||!config.current()||token!==serial)return;
      output.textContent='사용자 원문\n'+memorySuiteStripInternalSource(sample.user)+'\n\nAI 응답 원문\n'+memorySuiteStripInternalSource(sample.assistant);
    }catch(error){if(row.isConnected&&config.current()&&token===serial)output.textContent='원문 조회 실패: '+String(error?.message||error);}
  };
}

// Source text stays in the mounted view. Only user-confirmed tag rules are saved.
function memorySuiteExtractSelectedSourceTags(body,start,end) {
  if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||end<=start||end>body.length)return [];
  const names=[...new Set([...body.matchAll(/<\/?([a-z][a-z0-9:_-]*)(?=[\s/>])/gi)].map(m=>m[1].toLowerCase()))];
  const candidates=[];
  for(const name of names){
    if(memorySuiteIsInternalSourceRule(name))continue;
    const parsed=memorySuiteSourceTagRanges(body,[name]);
    if(parsed.invalid)continue;
    for(const range of parsed.ranges)if((range.start>=start&&range.end<=end)||(range.start<=start&&range.end>=end))
      candidates.push({entry:name,start:range.start,end:range.end});
  }
  // Literal module delimiters are editable too; never infer a rule from ordinary prose.
  const literals=[{open:'<!--',close:'-->'},...[...body.matchAll(/\[([^\]\r\n]{1,100}) START\]/g)].map(m=>({open:m[0],close:'['+m[1]+' END]'}))];
  for(const entry of literals){const parsed=memorySuiteLiteralRanges(body,[entry]);if(parsed.invalid)continue;
    for(const range of parsed.ranges)if((range.start>=start&&range.end<=end)||(range.start<=start&&range.end>=end))candidates.push({entry,start:range.start,end:range.end});}
  const inside=candidates.filter(r=>r.start>=start&&r.end<=end);
  const chosen=inside.length?inside:candidates.sort((a,b)=>(a.end-a.start)-(b.end-b.start)).slice(0,1);
  return [...new Map(chosen.map(r=>[JSON.stringify(r.entry),r.entry])).values()].slice(0,128);
}

function mountMemorySuiteReanalysisReview(container,config) {
  const doc=container.ownerDocument,make=(tag,text)=>{const n=doc.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
  const box=make('section');box.className='ms-source-settings';box.dataset.sourceReanalysisReview='';container.replaceChildren(box);
  const style=make('style');style.textContent=`
[data-source-reanalysis-review]{display:grid;grid-template-columns:minmax(0,1fr);gap:12px;min-width:0;padding:12px;border:1px solid #8885;border-radius:12px}
[data-source-reanalysis-review]>*{min-width:0;overflow-wrap:anywhere}
[data-source-reanalysis-review] label{grid-template-columns:minmax(0,1fr)}
[data-source-reanalysis-review] textarea{width:100%;min-height:180px;resize:vertical;font:13px/1.6 ui-monospace,monospace;white-space:pre}
[data-source-reanalysis-review] pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:360px;overflow:auto}
[data-source-reanalysis-review] [data-review-rule]{display:flex;gap:8px;flex-wrap:wrap;align-items:center;border:1px solid #8885;padding:10px;border-radius:10px}
[data-source-reanalysis-review] input{min-width:0;max-width:100%}[data-source-reanalysis-review] button{cursor:pointer;min-height:40px}
[data-source-reanalysis-review] [hidden]{display:none!important}
`;
  const status=make('p');status.dataset.reviewStatus='';status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  box.append(style,make('h3',config.sample.label+' · 확인 후 재분석'),make('p','원문에서 제외할 부분을 드래그한 뒤 태그를 추출하세요. 추출한 태그를 확인·편집하고 적용 결과를 확인할 수 있습니다. 저장한 태그 규칙은 이 플러그인의 앞으로의 분석에도 적용됩니다. 채팅 원문은 바꾸지 않습니다.'));
  const sources=[];let active=null,busy=false,applied=null,baseline=null;
  const valid=()=>box.isConnected&&config.current();
  const list=make('div'),preview=make('div'),extract=make('button','선택 영역에서 태그 추출'),add=make('button','태그 직접 추가'),apply=make('button','태그 적용'),run=make('button','태그 저장 후 재분석'),cancel=make('button','검토 닫기');
  extract.type=add.type=apply.type=run.type=cancel.type='button';extract.dataset.reviewExtract='';apply.dataset.reviewApply='';run.dataset.reviewRun='';run.disabled=true;
  const saved=make('details'),savedSummary=make('summary'),savedList=make('div');saved.append(savedSummary,savedList);list.dataset.reviewCandidates='';
  const updateSavedCount=()=>{savedSummary.textContent='저장된 태그 규칙 '+savedList.children.length+'개 · 확인·편집';};
  const rules=[];let applyVersion=0,expectedPolicy='';
  const policyKey=()=>JSON.stringify(memorySuiteNormalizeSourceRules(config.policy.sourceRules()));
  const assertPolicy=()=>{if(policyKey()!==expectedPolicy)throw Error('저장된 태그 규칙이 변경되었습니다. 검토를 다시 열어 주세요.');};
  function dirty(){applyVersion++;applied=null;run.disabled=true;preview.replaceChildren();status.textContent='태그를 적용해 분석할 내용을 먼저 확인하세요.';}
  function addRule(entry={open:'',close:''},key='ignoredTags',control=null,target=list){
    const row=make('div'),open=make('input'),close=make('input'),action=make('select'),remove=make('button','삭제');row.dataset.reviewRule='';
    const form=memorySuiteSourceRuleForm(entry);open.value=form.open;close.value=form.close;open.maxLength=close.maxLength=256;
    open.setAttribute('aria-label','여는 태그');close.setAttribute('aria-label','닫는 태그');
    for(const [value,label]of [['ignoredTags','내용 전체 제외'],['unwrapTags','태그만 제거'],['sourceTags','이 안만 분석']]){const option=make('option',label);option.value=value;action.append(option);}action.value=key;action.setAttribute('aria-label','태그 처리 방법');
    remove.type='button';const value={row,open,close,action,control};rules.push(value);
    open.oninput=close.oninput=action.onchange=dirty;remove.onclick=()=>{if(busy)return;rules.splice(rules.indexOf(value),1);row.remove();updateSavedCount();dirty();};row.append(open,close,action,remove);target.append(row);updateSavedCount();return value;
  }
  function read(){const draft={version:1,ignoredTags:[],unwrapTags:[],sourceTags:[],controls:[]};
    for(const row of rules){if(!row.open.value.trim()&&!row.close.value.trim())continue;const entry={open:row.open.value,close:row.close.value},form=row.control&&memorySuiteSourceRuleForm('@'+row.control);if(form&&row.action.value==='ignoredTags'&&entry.open===form.open&&entry.close===form.close)draft.controls.push(row.control);else draft[row.action.value].push(entry);}
    return memorySuiteNormalizeSourceRules(draft);
  }
  function lock(value){busy=value;for(const n of box.querySelectorAll('input,select,button'))n.disabled=value;run.disabled=value||!applied;}
  for(const [role,label]of [['user','사용자 원문'],['assistant','AI 응답 원문']]){
    const wrap=make('label',label),input=make('textarea');input.readOnly=true;input.value=memorySuiteStripInternalSource(config.sample[role]||'');input.setAttribute('aria-label',label);input.dataset.reviewSource=role;
    const select=()=>{active=input;};input.onselect=input.onmouseup=input.onkeyup=select;wrap.append(input);box.append(wrap);sources.push({role,input});
  }
  const actions=make('div');actions.className='cluster';actions.append(extract,add);box.append(actions,make('h3','앞으로 적용할 태그 규칙'),saved,list,apply,preview,run,cancel,status);
  extract.onclick=()=>{
    if(busy)return;if(!active){status.textContent='원문에서 제외할 영역을 먼저 선택하세요.';return;}const entries=memorySuiteExtractSelectedSourceTags(active.value,active.selectionStart,active.selectionEnd);
    if(!entries.length){status.textContent='선택 영역에서 짝이 맞는 태그를 찾지 못했습니다. 태그를 포함해 선택하거나 직접 추가하세요.';return;}
    let first;
    for(const entry of entries){const form=memorySuiteSourceRuleForm(entry),existing=rules.find(r=>r.open.value===form.open&&r.close.value===form.close);const row=existing||addRule(entry);if(existing&&savedList.contains(existing.row))saved.open=true;first||=row;}
    dirty();status.textContent='추출한 태그를 확인·편집한 뒤 태그 적용을 누르세요.';
    first?.row.scrollIntoView?.({block:'nearest'});
  };
  add.onclick=()=>{if(busy)return;addRule();dirty();rules.at(-1).open.focus();};
  apply.onclick=async()=>{
    if(busy||!baseline||!valid())return;const version=++applyVersion;
    try{
      assertPolicy();const draft=read();preview.replaceChildren();let warned=false;
      const same=JSON.stringify(draft)===JSON.stringify(baseline.rules);
      for(const {role,input}of sources){
        const raw=config.sample[role]||'';
        const result=baseline.legacy&&same?{text:await config.projectLegacySample({text:raw,role}),warnings:[]}:memorySuiteProjectSourceRules(input.value,draft);
        if(!valid()||version!==applyVersion)return;
        if(!String(result.text||'').trim())throw Error('분석할 '+(role==='user'?'사용자 내용':'AI 응답')+'이 비어 있습니다. 제외 규칙을 확인하세요.');
        const output=make('pre',result.text);output.dataset.reviewOutput=role;preview.append(make('h3',role==='user'?'분석할 사용자 내용':'분석할 AI 응답'),output);
        for(const warning of result.warnings){preview.append(make('p',warning));warned=true;}
      }
      applied=JSON.stringify(draft);run.disabled=false;status.textContent=warned?'경고와 실제 분석 입력을 확인하세요. 저장 후 재분석할 수 있습니다.':'적용 결과를 확인했습니다. 태그를 저장한 뒤 재분석할 수 있습니다.';
    }catch(error){dirty();status.textContent='태그 적용 실패: '+String(error?.message||error);}
  };
  run.onclick=async()=>{
    if(busy||!applied||!valid())return;lock(true);config.onBusy?.(true);
    try{
      // Validate before the settings write and again before dispatching. A review
      // cannot silently apply to edited text or to a different chat/selection.
      await config.validate();if(!valid())return;assertPolicy();
      const draft=read();if(JSON.stringify(draft)!==applied)throw Error('태그 적용 결과가 만료되었습니다. 다시 적용하세요.');
      if(JSON.stringify(draft)!==JSON.stringify(baseline.rules)){
        await config.policy.setSourceRules(draft);expectedPolicy=JSON.stringify(draft);
        baseline={rules:draft,legacy:false};
      }
      if(!valid())return;await config.validate();if(!valid())return;
      status.textContent='태그 저장을 확인했습니다. 재분석을 준비합니다.';
      const guard=async()=>{await config.validate();if(policyKey()!==JSON.stringify(draft))throw Error('저장된 태그 규칙이 변경되었습니다. 다시 확인하세요.');};
      await config.onRun(guard);
    }catch(error){if(valid())status.textContent='재분석 중단: '+String(error?.message||error);}
    finally{config.onBusy?.(false);if(valid())lock(false);}
  };
  cancel.onclick=()=>{if(!busy){container.replaceChildren();config.onClose?.();}};
  lock(true);
  config.policy.ready().then(prefs=>{
    if(!valid())return;const draft=config.policy.sourceRules();baseline={rules:memorySuiteNormalizeSourceRules(draft),legacy:!prefs.sourceRules};expectedPolicy=policyKey();
    for(const key of ['ignoredTags','unwrapTags','sourceTags'])for(const entry of draft[key])addRule(entry,key,null,savedList);
    for(const control of draft.controls)addRule(memorySuiteSourceRuleForm('@'+control),'ignoredTags',control,savedList);
    lock(false);status.textContent='제외할 영역을 선택하거나 저장된 규칙을 적용해 원문을 확인하세요.';
  }).catch(error=>{if(valid())status.textContent='규칙 조회 실패: '+String(error?.message||error);});
  return box;
}
/* MEMORY SUITE SOURCE INPUT CONTROLS v1 END */
