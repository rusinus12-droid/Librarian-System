/* LIBRA SOURCE INPUT POLICY v1 — optional normalization only; no edit tracking. */
function memorySuiteSourceIgnoredTags(value) {
  const input = value === undefined ? ['lb-xnai'] : typeof value === 'string' ? value.split(/\r?\n/) : value;
  if (!Array.isArray(input) || input.length > 128) throw Error('SOURCE_IGNORE_TAGS_INVALID: 태그는 최대 128개입니다.');
  const names = input.map(v => String(v).trim().toLowerCase()).filter(Boolean);
  if (names.some(v => !/^[a-z][a-z0-9:_-]{0,63}$/.test(v))) throw Error('SOURCE_IGNORE_TAGS_INVALID: 꺾쇠 없이 태그 이름만 입력하세요.');
  return [...new Set(names)].sort();
}
function memorySuiteSourceTagPolicy(owner, tags) {
  const policies = memorySuiteSourceTagPolicy.policies || (memorySuiteSourceTagPolicy.policies = new Map());
  if (tags !== undefined) policies.set(owner, memorySuiteSourceIgnoredTags(tags));
  return policies.get(owner) || ['lb-xnai'];
}
function memorySuiteSourceTagKey(owner) { return JSON.stringify([memorySuiteSourceTagPolicy(owner),memorySuiteSourceRules(owner)]); }
function memorySuiteProjectSourceTags(value, owner) {
  const explicit=memorySuiteCanonicalSource(value,owner);if(explicit!==null)return explicit;
  let body = String(value ?? '');
  const names = new Set(memorySuiteSourceTagPolicy(owner));
  // Retain the established illustration rule: narrative inside lb-xnai is evidence.
  if (names.delete('lb-xnai')) body = body
    .replace(/<lb-xnai\b(?:"[^"]*"|'[^']*'|[^'">])*?>([\s\S]*?)<\/lb-xnai\s*>/gi, (whole, inner) => inner.replace(/\{\{inlay::[^{}\r\n]+\}\}/gi, '').trim() === '' ? '' : whole)
    .replace(/<lb-xnai\b(?:"[^"]*"|'[^']*'|[^'">])*?\/\s*>/gi, '');
  if (!names.size) return body;
  const tokens = /<\/?([a-z][a-z0-9:_-]*)(?=[\s/>])(?:"[^"]*"|'[^']*'|[^'">])*?>/gi;
  const ranges = [], stack = []; let start = -1, match;
  while ((match = tokens.exec(body))) {
    const name = match[1].toLowerCase(); if (!names.has(name)) continue;
    const closing = /^<\//.test(match[0]), selfClosing = /\/\s*>$/.test(match[0]);
    if (closing) {
      if (stack.at(-1) !== name) { stack.length = 0; start = -1; continue; }
      stack.pop(); if (!stack.length) { ranges.push([start, tokens.lastIndex]); start = -1; }
    } else if (selfClosing) { if (!stack.length) ranges.push([match.index, tokens.lastIndex]); }
    else { if (!stack.length) start = match.index; stack.push(name); }
  }
  // Incomplete/mismatched blocks are retained. Never delete through end-of-message.
  for (let i = ranges.length - 1; i >= 0; i--) body = body.slice(0, ranges[i][0]) + body.slice(ranges[i][1]);
  return body;
}
// Rules are a projection, never an authorization to rewrite stored evidence.
function memorySuiteDefaultSourceRules(owner) {
  // External defaults are shared; saved owner-specific policies remain authoritative.
  // Do not broadly discard status, choices, or other potential narrative evidence.
  return {version:1,ignoredTags:[...new Set([...memorySuiteSourceTagPolicy(owner),'thoughts'])],unwrapTags:[],sourceTags:[],controls:['html-comment','lbdata']};
}
function memorySuiteSourceRules(owner, next) {
  const policies=memorySuiteSourceRules.policies||(memorySuiteSourceRules.policies=new Map());
  if(next!==undefined) policies.set(owner,next);
  return policies.get(owner)||null;
}
function memorySuiteNormalizeSourceEntries(input, key) {
  const items=typeof input==='string'?input.split(/\r?\n/):input??[];
  if(!Array.isArray(items)||items.length>128)throw Error('SOURCE_RULES_INVALID: 규칙은 각 최대 128개입니다.');
  const out=[];
  for(const item of items){
    if(typeof item==='string'){out.push(...memorySuiteSourceIgnoredTags([item]));continue;}
    if(!item||typeof item.open!=='string'||typeof item.close!=='string')throw Error('SOURCE_DELIMITER_INVALID');
    const {open,close}=item;
    if(!open.trim()||close!==''&&!close.trim()||open.length>256||close.length>256||open===close||key==='sourceTags'&&!close.trim())throw Error('SOURCE_DELIMITER_INVALID: 여는 표식과 서로 다른 닫는 표식을 입력하세요. 단일 표식은 원문 선택에 사용할 수 없습니다.');
    // Standard tag pairs retain attribute/case handling and existing illustration behavior.
    const tag=/^<([a-z][a-z0-9:_-]*)>$/i.exec(open);
    if(tag&&close.toLowerCase()==='</'+tag[1].toLowerCase()+'>')out.push(tag[1].toLowerCase());
    else out.push({open,close});
  }
  return [...new Map(out.map(x=>[JSON.stringify(x),x])).values()];
}
function memorySuiteLiteralRanges(body, rules) {
  const types=rules.filter(x=>x&&typeof x==='object'),stack=[],ranges=[],tokens=[];let pos=0,invalid=false;
  const markers=types.flatMap((r,id)=>[{text:r.open,id,close:false},...(r.close?[{text:r.close,id,close:true}]:[])]);
  while(pos<body.length){
    let next=null;
    for(const marker of markers){const start=body.indexOf(marker.text,pos);if(start<0)continue;if(!next||start<next.start||start===next.start&&marker.text.length>next.text.length)next={...marker,start,end:start+marker.text.length};}
    if(!next)break;pos=next.end;tokens.push(next);
    if(next.close){const opening=stack.pop();if(!opening||opening.id!==next.id){invalid=true;stack.length=0;continue;}if(!stack.length)ranges.push({start:opening.start,end:next.end,innerStart:opening.end,innerEnd:next.start});}
    else if(!types[next.id].close){if(!stack.length)ranges.push({start:next.start,end:next.end,innerStart:next.end,innerEnd:next.end});}
    else stack.push(next);
  }
  return {ranges,tokens,invalid:invalid||stack.length>0};
}
function memorySuiteSourceRanges(body, entries) {
  const tags=memorySuiteSourceTagRanges(body,entries.filter(x=>typeof x==='string'));
  const literal=memorySuiteLiteralRanges(body,entries);
  return {ranges:[...tags.ranges,...literal.ranges].sort((a,b)=>a.start-b.start),tokens:[...tags.tokens,...literal.tokens],invalid:tags.invalid||literal.invalid};
}
function memorySuiteEraseSourceRanges(body,ranges){
  const sorted=[...ranges].sort((a,b)=>a.start-b.start||b.end-a.end),parts=[];let pos=0;
  for(const r of sorted){if(r.start>pos)parts.push(body.slice(pos,r.start));pos=Math.max(pos,r.end);}
  parts.push(body.slice(pos));return parts.join('');
}
function memorySuiteSourceRuleForm(value){
  if(typeof value==='object')return value;
  if(value==='@html-comment')return {open:'<!--',close:'-->'};
  if(value==='@lbdata')return {open:'[LBDATA START]',close:'[LBDATA END]'};
  if(value==='@inlay')return {open:'{{inlay::',close:'}}'};
  if(value==='@suite-blocks')return {open:'Suite 기억·패킷 표식',close:'기존 기본 묶음'};
  return {open:'<'+value+'>',close:'</'+value+'>'};
}

function memorySuiteNormalizeSourceRules(input) {
  if(!input||typeof input!=='object'||Array.isArray(input)||(input.version!=null&&input.version!==1)||input.controls!=null&&!Array.isArray(input.controls))throw Error('SOURCE_RULES_INVALID');
  const result={version:1};
  const rawIgnored=typeof input.ignoredTags==='string'?input.ignoredTags.split(/\r?\n/):input.ignoredTags??[];
  if(!Array.isArray(rawIgnored))throw Error('SOURCE_RULES_INVALID');
  const special=rawIgnored.map(String).map(x=>x.trim()).filter(x=>x.startsWith('@')).map(x=>x.slice(1));
  result.ignoredTags=memorySuiteNormalizeSourceEntries(rawIgnored.filter(x=>typeof x!=='string'||!x.trim().startsWith('@')),'ignoredTags');
  for(const key of ['unwrapTags','sourceTags'])result[key]=memorySuiteNormalizeSourceEntries(input[key]??[],key);
  const all=[...result.ignoredTags,...result.unwrapTags,...result.sourceTags];
  if(new Set(all.map(x=>JSON.stringify(x))).size!==all.length)throw Error('SOURCE_RULES_CONFLICT: 같은 태그를 여러 규칙에 지정할 수 없습니다.');
  const markers=new Set();for(const entry of all){const f=typeof entry==='string'?{open:'<'+entry+'>',close:'</'+entry+'>'}:entry;for(const marker of [f.open,f.close].filter(Boolean)){if(markers.has(marker))throw Error('SOURCE_RULES_CONFLICT: 같은 여는/닫는 표식을 여러 규칙에 사용할 수 없습니다.');markers.add(marker);}}
  result.controls=[...new Set([...(input.controls??[]),...special])].sort();
  if(result.controls.some(x=>!['html-comment','lbdata','suite-blocks','inlay'].includes(x)))throw Error('SOURCE_RULES_CONTROL_INVALID');
  for(const entry of all){if(typeof entry!=='object')continue;for(const control of result.controls){const form=memorySuiteSourceRuleForm('@'+control);if(entry.open===form.open&&entry.close===form.close)throw Error('SOURCE_RULES_CONFLICT: 같은 기본 규칙이 이미 등록되어 있습니다.');}}
  return result;
}
function memorySuiteSourceTagRanges(body, names) {
  const wanted=new Set(names),stack=[],ranges=[],tokens=[];let invalid=false,m;
  const re=/<!--[\s\S]*?(?:-->|$)|<\/?([a-z][a-z0-9:_-]*)(?=[\s/>])(?:"[^"]*"|'[^']*'|[^'">])*?>/gi;
  while((m=re.exec(body))){
    if(!m[1]||!wanted.has(m[1].toLowerCase()))continue;
    const token={start:m.index,end:re.lastIndex,name:m[1].toLowerCase(),close:/^<\//.test(m[0]),self:/\/\s*>$/.test(m[0])};tokens.push(token);
    if(token.close){const open=stack.pop();if(!open||open.name!==token.name){invalid=true;stack.length=0;continue;}if(!stack.length)ranges.push({start:open.start,end:token.end,innerStart:open.end,innerEnd:token.start});}
    else if(token.self || token.name==='img'&&!/<\/img\s*>/i.test(body.slice(token.end))){if(!stack.length)ranges.push({start:token.start,end:token.end,innerStart:token.end,innerEnd:token.end});}
    else stack.push(token);
  }
  return {ranges,tokens,invalid:invalid||stack.length>0};
}
function memorySuiteProjectSourceRules(value,rules) {
  let body=String(value??'');const warnings=[];
  if(rules.sourceTags.length){
    const parsed=memorySuiteSourceRanges(body,rules.sourceTags);
    if(parsed.tokens.length){
      if(parsed.invalid||parsed.ranges.length!==1||parsed.tokens.length!==2||!body.slice(parsed.ranges[0]?.innerStart,parsed.ranges[0]?.innerEnd).trim())warnings.push('원문 영역이 비어 있거나 불완전·중복되어 전체 본문을 사용합니다.');
      else {const r=parsed.ranges[0];body=body.slice(r.innerStart,r.innerEnd);}
    }
  }
  // A malformed selection fails back to the full original, not a partial projection.
  if(warnings.length)return {text:String(value??''),warnings};
  const dropped=memorySuiteSourceRanges(body,rules.ignoredTags);
  if(dropped.invalid)warnings.push('닫히지 않거나 짝이 맞지 않는 제외 태그는 보존합니다.');
  if(!dropped.invalid)body=memorySuiteEraseSourceRanges(body,dropped.ranges.filter(r=>{
    const opening=body.slice(r.start,r.innerStart);
    return !(/^<lb-xnai\b/i.test(opening)&&body.slice(r.innerStart,r.innerEnd).replace(/\{\{inlay::[^{}\r\n]+\}\}/gi,'').trim());
  }));
  const unwrapped=memorySuiteSourceRanges(body,rules.unwrapTags);
  if(unwrapped.invalid)warnings.push('닫히지 않거나 짝이 맞지 않는 제거 표식은 보존합니다.');
  else body=memorySuiteEraseSourceRanges(body,unwrapped.tokens);
  for(const control of rules.controls){
    if(control==='html-comment')body=body.replace(/<!--[\s\S]*?-->/g,'');
    if(control==='lbdata')body=body.replace(/\[LBDATA START\][\s\S]*?\[LBDATA END\]/gi,'');
    if(control==='inlay')body=body.replace(/\{\{inlay::[^{}\r\n]+\}\}/gi,'');
    if(control==='suite-blocks')body=body
      .replace(/\[(HAYAKU (?:PACKET MEMORY|PACKET WRITE|CONTINUITY CONTEXT|IMMUTABLE CORE|RAW SOURCE ATTACHMENT|RAW SOURCE TIMELINE)|VECTOR RAG MEMORY|FLASHBACK EVIDENCE|ACTIVE CONTINUITY EVIDENCE|PAST EVIDENCE RULES)\][\s\S]*?\[\/\1\]/gi,'')
      .replace(/<<<\s*HAYAKU_STATE_PACKET_START\s*>>>[\s\S]*?<<<\s*HAYAKU_STATE_PACKET_END\s*>>>|HAYAKU_STATE_PACKET_START\b[\s\S]*?\bHAYAKU_STATE_PACKET_END/gi,'');
  }
  return {text:body,warnings};
}
// Only Suite-owned protocol envelopes belong here. External module markup remains editable.
function memorySuiteIsInternalSourceRule(entry) {
  if(typeof entry==='string')return entry==='hayaku_packet_contract'||entry==='@suite-blocks';
  if(!entry||typeof entry.open!=='string')return false;
  return /^\[(?:HAYAKU (?:PACKET MEMORY|PACKET WRITE|CONTINUITY CONTEXT|IMMUTABLE CORE|RAW SOURCE ATTACHMENT|RAW SOURCE TIMELINE)|VECTOR RAG MEMORY|FLASHBACK EVIDENCE|ACTIVE CONTINUITY EVIDENCE|PAST EVIDENCE RULES)\]$/i.test(entry.open)
    || /^(?:<<<\s*)?HAYAKU_STATE_PACKET_START(?:\s*>>>)?$/.test(entry.open);
}
function memorySuiteExternalSourceRules(rules, migrate=false) {
  const out={...rules};
  for(const key of ['ignoredTags','unwrapTags','sourceTags'])out[key]=rules[key].filter(x=>!memorySuiteIsInternalSourceRule(x)&&!(migrate&&x==='dag_runtime_contract'));
  out.controls=rules.controls.filter(x=>x!=='suite-blocks');return out;
}
function memorySuiteStripInternalSource(value) {
  const body=String(value??'').replace(/<!--\s*HAYAKU_STATE_PACKET_START\b[\s\S]*?\bHAYAKU_STATE_PACKET_END\s*-->/gi,'');
  return memorySuiteProjectSourceRules(body,{sourceTags:[],ignoredTags:['hayaku_packet_contract'],unwrapTags:[],controls:['suite-blocks']}).text;
}

function memorySuiteCanonicalSource(value,owner) {
  const rules=memorySuiteSourceRules(owner);if(!rules)return null;
  // No hidden content removal after applying the user's explicit rules.
  return memorySuiteProjectSourceRules(memorySuiteStripInternalSource(value),rules).text.replace(/\r\n/g,'\n').trim();
}

function createMemorySuiteSourceInputPolicy(config) {
  const owner=config.owner||'libra';
  if(!['libra','hayaku','flashback'].includes(owner))throw Error('SOURCE_INPUT_OWNER_INVALID');
  const clone=value=>JSON.parse(JSON.stringify(value));
  let preferences=null,loading=null,saving=null,disposed=false;
  async function ready() {
    if(saving)await saving;
    if(preferences)return preferences;
    if(!loading)loading=(async()=>{
      const raw=await config.read();
      // A malformed stored preference (hand-edited or torn) must not take the whole
      // plugin down at startup: fall back to defaults and say so. Nothing is
      // written back until the user saves the rules again.
      let value;
      try{value=raw==null||raw===''?{}:typeof raw==='string'?JSON.parse(raw):clone(raw);}catch(error){value=null;}
      if(!value||typeof value!=='object'||Array.isArray(value)){
        try{globalThis.__memorySuiteSourceInputPreferenceErrors={...(globalThis.__memorySuiteSourceInputPreferenceErrors||{}),[owner]:{at:Date.now(),reason:'SOURCE_INPUT_PREFERENCES_INVALID'}};}catch(_){}
        try{console.warn('[memory-suite] '+owner+' source input preferences unreadable; using defaults');}catch(_){}
        value={};
      }
      value.ignoredTags=memorySuiteSourceIgnoredTags(value.ignoredTags)
        .filter(x=>!memorySuiteIsInternalSourceRule(x)&&!(value.externalRulesVersion!==1&&x==='dag_runtime_contract'));
      if(value.sourceRules)value.sourceRules={...value.sourceRules,...memorySuiteExternalSourceRules(memorySuiteNormalizeSourceRules(value.sourceRules),value.externalRulesVersion!==1)};
      value.externalRulesVersion=1;
      if(disposed)throw Error('SOURCE_INPUT_DISPOSED');
      preferences=value;
      memorySuiteSourceTagPolicy(owner,value.ignoredTags);memorySuiteSourceRules(owner,value.sourceRules||null);
      return value;
    })().finally(()=>{loading=null;});
    return loading;
  }
  const loadPreferences=ready;
  const sourceRules=()=>clone(memorySuiteSourceRules(owner)||memorySuiteDefaultSourceRules(owner));
  function save(input,ruleInput) {
    if(saving||config.busy?.()===true)return Promise.reject(Error('SOURCE_IGNORE_TAGS_BUSY: 현재 요청·처리가 끝난 뒤 저장하세요.'));
    const work=(async()=>{
      await ready();
      const proposed=ruleInput===undefined?null:memorySuiteNormalizeSourceRules(ruleInput);
      if(proposed&&([...proposed.ignoredTags,...proposed.unwrapTags,...proposed.sourceTags].some(memorySuiteIsInternalSourceRule)||proposed.controls.includes('suite-blocks')))throw Error('SOURCE_RULES_INTERNAL: Suite 자체 운용 표식은 내부에서 처리합니다.');
      const ignoredTags=(proposed?proposed.ignoredTags.filter(x=>typeof x==='string'):memorySuiteSourceIgnoredTags(input)).filter(x=>!memorySuiteIsInternalSourceRule(x));
      const normalized=proposed||(preferences.sourceRules?memorySuiteNormalizeSourceRules({...preferences.sourceRules,ignoredTags}):null);
      const rules=normalized?{...(preferences.sourceRules||{}),...normalized}:null;
      const desired={...preferences,ignoredTags,...(rules?{sourceRules:rules}:{}),externalRulesVersion:1},body=JSON.stringify(desired);
      if(disposed||config.busy?.()===true)throw Error('SOURCE_IGNORE_TAGS_BUSY');
      if(await config.write(body)===false)throw Error('SOURCE_INPUT_WRITE_REJECTED');
      const raw=await config.read();if((typeof raw==='string'?raw:JSON.stringify(raw))!==body)throw Error('SOURCE_INPUT_READBACK_FAILED');
      if(disposed)throw Error('SOURCE_INPUT_DISPOSED');
      preferences=desired;memorySuiteSourceTagPolicy(owner,ignoredTags);memorySuiteSourceRules(owner,rules);
      return {sourceRules:sourceRules(),ignoredTags:[...ignoredTags]};
    })();
    saving=work;return work.finally(()=>{if(saving===work)saving=null;});
  }
  const setSourceRules=input=>save(null,input);
  // readSample is an explicit local read: string or {text,label?,role?}; never stored.
  // projectLegacySample preserves the owner's actual normalizer until rules are edited.
  function mountControls(container) {
    if(!container?.ownerDocument||container.querySelector('[data-source-input-controls]'))return;
    const doc=container.ownerDocument,box=doc.createElement('section');
    box.dataset.sourceInputControls=owner;box.className='ms-source-settings';container.prepend(box);
    const make=(tag,text)=>{const node=doc.createElement(tag);if(text!==undefined)node.textContent=text;return node;};
    const style=make('style');style.textContent=`
.ms-source-settings{font:14px/1.6 system-ui,-apple-system,'Malgun Gothic',sans-serif;display:grid;gap:14px;width:100%;max-width:960px;margin:0 auto 24px;color:inherit}
.ms-source-settings *{box-sizing:border-box}.ms-source-settings p,.ms-source-settings h3{margin:0}.ms-source-settings h3{font-size:18px}.ms-source-settings label{display:grid;gap:5px;font-size:13px}.ms-source-settings small{opacity:.8}
.ms-source-settings button,.ms-source-settings input,.ms-source-settings textarea,.ms-source-settings select{font:inherit;color:inherit;border:1px solid #8887;border-radius:9px;background:transparent;min-width:0;padding:8px 10px}.ms-source-settings textarea{width:100%;resize:vertical;min-height:42px}.ms-source-settings button{cursor:pointer;min-height:40px}.ms-source-settings button:disabled{opacity:.5;cursor:default}.ms-source-settings :is(button,input,textarea,select):focus-visible{outline:2px solid currentColor;outline-offset:2px}
.ms-source-settings .ms-input-list{display:grid;gap:10px}.ms-source-settings .ms-input-row{border:1px solid #8885;border-radius:12px;padding:14px;display:grid;grid-template-columns:minmax(0,1fr) minmax(160px,230px) auto;gap:10px;align-items:start}.ms-source-settings .ms-input-fields{display:grid;gap:8px}.ms-source-settings .ms-custom-toggle{display:flex;align-items:center;gap:8px}.ms-source-settings .ms-custom-toggle input{margin:0}.ms-source-settings .ms-custom-fields{display:grid;grid-template-columns:1fr 1fr;gap:8px}.ms-source-settings [hidden]{display:none!important}
.ms-source-settings .ms-input-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.ms-source-settings .ms-input-apply{background:#79522d;color:white;border-color:#79522d;font-weight:700}.ms-source-settings .ms-input-status{min-height:24px}.ms-source-settings .ms-input-preview{border-top:1px solid #8885;padding-top:14px;display:grid;gap:10px}.ms-source-settings pre{font:13px/1.6 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere;border:1px solid #8885;border-radius:10px;padding:14px;max-height:360px;overflow:auto;margin:0}.ms-source-settings .ms-input-warning{border-left:3px solid #b9802e;padding-left:10px}.ms-source-settings details{font-size:13px}.ms-source-settings summary{cursor:pointer}
@media(max-width:600px){.ms-source-settings .ms-input-row{grid-template-columns:minmax(0,1fr) auto}.ms-source-settings .ms-input-fields{grid-column:1/-1}.ms-source-settings .ms-custom-fields{grid-template-columns:1fr}.ms-source-settings .ms-input-actions button{flex:1}}
`;
    box.append(style,make('h3','분석할 내용'),make('p','설정 없이 바로 사용할 수 있습니다. 알 수 없는 외부 태그와 내용은 그대로 둡니다. 필요한 경우에만 아래 규칙을 바꾸세요.'));
    const list=make('div');list.dataset.sourceInputList='';list.className='ms-input-list';box.append(list);
    const actions=make('div'),apply=make('button','적용'),status=make('p');actions.className='ms-input-actions';apply.type='button';apply.className='ms-input-apply';apply.dataset.sourceInputApply='';apply.disabled=true;
    status.dataset.sourceInputStatus='';status.className='ms-input-status';status.setAttribute('role','status');status.setAttribute('aria-live','polite');
    actions.append(apply);box.append(actions,status,make('p','규칙은 적용을 눌러야 저장됩니다. 기존 기억은 그대로 유지되며, 바꾸려면 원하는 구간을 직접 재분석하세요.'));
    const previewArea=make('section'),previewButton=make('button','현재 채팅 미리보기'),previewStatus=make('p'),warning=make('p'),output=make('pre');
    previewArea.className='ms-input-preview';previewButton.type='button';previewButton.dataset.sourceInputPreview='';previewButton.disabled=true;
    previewStatus.dataset.sourceInputPreviewStatus='';previewStatus.setAttribute('role','status');previewStatus.setAttribute('aria-live','polite');
    warning.dataset.sourceInputWarning='';warning.className='ms-input-warning';warning.setAttribute('role','alert');warning.hidden=true;
    output.dataset.sourceInputOutput='';output.hidden=true;output.setAttribute('aria-label','실제 분석 입력 미리보기');
    previewArea.append(previewButton,make('small','현재 채팅에서 불러온 메시지를 기준으로 실제 분석 입력을 보여 줍니다. AI를 호출하지 않으며 미리보기 본문을 저장하거나 로그에 남기지 않습니다.'),previewStatus,warning,output);box.append(previewArea);
    const help=make('details'),summary=make('summary','규칙 사용 방법');help.append(summary,make('p','태그 이름(예: original), 여는 태그 또는 XML 예시를 붙여 넣으세요. 표준 태그는 닫는 태그를 자동으로 찾습니다. 일반 표식은 직접 구분자를 켜고 여는 표식과 닫는 표식을 입력하세요. 내용 전체 제외 → 태그와 내용 제거, 태그만 제거 → 안의 내용 유지, 이 안만 분석 → 바깥 내용 제외입니다. 적용 순서는 이 안만 분석, 내용 전체 제외, 태그만 제거입니다. 선택 영역이 비어 있거나 불완전·중복이면 전체 본문을 사용하며 미리보기에 경고합니다. Suite 자체 운용 표식은 내부에서 처리합니다.'));box.append(help);
    const controlLabels={'html-comment':'HTML 주석','lbdata':'LBDATA 제어 블록','inlay':'삽화 호출'};
    const actionNames={ignoredTags:'내용 전체 제외',unwrapTags:'태그만 제거',sourceTags:'이 안만 분석'};
    let rows=[],loaded=false,applying=false,initial='',legacy=false,sample=null,previewVersion=0,readingSample=false;
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
        if(disposed||version!==previewVersion)return;
        output.textContent=String(projected.text??'').replace(/\r\n/g,'\n').trim();output.hidden=false;
        warning.textContent=projected.warnings.join(' ');warning.hidden=!projected.warnings.length;
        previewStatus.textContent=(sample.label?sample.label+' · ':'')+(output.textContent?'불러온 메시지의 분석 입력':'분석할 내용이 없습니다.')+(fingerprint(rules)!==initial?' · 아직 적용하지 않은 규칙':'');
      }catch(e){if(disposed||version!==previewVersion)return;warning.textContent=String(e.message||e);warning.hidden=false;previewStatus.textContent='규칙을 확인한 뒤 다시 미리 보세요.';}
    }
    function changed() {
      if(!loaded||applying)return;
      if(!rows.some(isEmpty))addRow();
      status.textContent='변경한 규칙을 적용해 주세요.';setEnabled();void showPreview();
    }
    function addRow(value=null,key='ignoredTags',control=null) {
      const element=make('div'),fields=make('div'),tagLabel=make('label','태그 이름 또는 XML 예시'),valueInput=make('textarea'),customLabel=make('label'),custom=make('input'),customFields=make('div'),open=make('input'),close=make('input'),actionLabel=make('label','처리 방법'),action=make('select'),remove=make('button','삭제');
      element.dataset.sourceInputRow='';element.className='ms-input-row';fields.className='ms-input-fields';tagLabel.dataset.ruleTagLabel='';
      valueInput.dataset.ruleValue='';valueInput.rows=1;valueInput.placeholder='예: decoration 또는 <decoration>예시</decoration>';tagLabel.append(valueInput);
      custom.type='checkbox';custom.dataset.ruleCustom='';customLabel.className='ms-custom-toggle';customLabel.append(custom,make('span','직접 구분자'));
      customFields.className='ms-custom-fields';open.dataset.ruleOpen='';close.dataset.ruleClose='';open.type=close.type='text';open.maxLength=close.maxLength=256;
      const openLabel=make('label','여는 표식'),closeLabel=make('label','닫는 표식');openLabel.append(open);closeLabel.append(close);customFields.append(openLabel,closeLabel);
      for(const [optionValue,label]of Object.entries(actionNames)){const option=make('option',label);option.value=optionValue;action.append(option);}action.value=key;action.dataset.ruleAction='';actionLabel.append(action);
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
      remove.onclick=()=>{if(!loaded||applying||isEmpty(row))return;rows=rows.filter(item=>item!==row);element.remove();changed();};
      fields.append(tagLabel,customLabel,customFields);if(control)fields.append(make('small',controlLabels[control]||'저장된 기본 규칙'));
      element.append(fields,actionLabel,remove);list.append(element);return row;
    }
    function fill() {
      rows=[];list.replaceChildren();const rules=sourceRules();
      for(const key of Object.keys(actionNames))for(const entry of rules[key])addRow(entry,key);
      for(const control of rules.controls)addRow(memorySuiteSourceRuleForm('@'+control),'ignoredTags',control);
      addRow();initial=fingerprint(rules);legacy=!preferences.sourceRules;setEnabled();
    }
    apply.onclick=async()=>{
      if(!loaded||applying||disposed)return;
      let rules;try{rules=readDraft();if(fingerprint(rules)===initial)return;}catch(e){status.textContent='적용 실패: '+String(e.message||e);return;}
      applying=true;status.textContent='적용 중…';setEnabled();
      try{await setSourceRules(rules);if(disposed)return;fill();status.textContent='규칙을 적용했습니다. 기존 기억은 유지됩니다.';await showPreview();}
      catch(e){if(!disposed)status.textContent='적용 실패: '+String(e.message||e);}
      finally{applying=false;if(!disposed)setEnabled();}
    };
    previewButton.onclick=async()=>{
      if(!loaded||readingSample||disposed||typeof config.readSample!=='function')return;
      readingSample=true;sample=null;const version=++previewVersion;output.textContent='';output.hidden=true;warning.textContent='';warning.hidden=true;previewStatus.textContent='현재 채팅을 읽는 중…';setEnabled();
      try{
        const result=await config.readSample();if(disposed||version!==previewVersion)return;
        if(result==null){previewStatus.textContent='현재 채팅에 미리 볼 메시지가 없습니다.';return;}
        if(typeof result!=='string'&&typeof result.text!=='string')throw Error('SOURCE_SAMPLE_INVALID');
        sample=typeof result==='string'?{text:result}:result;await showPreview();
      }catch{if(!disposed&&version===previewVersion)previewStatus.textContent='현재 채팅을 읽지 못했습니다. 잠시 뒤 다시 미리 보세요.';}
      finally{readingSample=false;if(!disposed)setEnabled();}
    };
    status.textContent='저장된 규칙을 읽는 중…';
    loadPreferences().then(()=>{if(disposed)return;loaded=true;fill();status.textContent='';if(typeof config.readSample!=='function')previewStatus.textContent='현재 채팅 미리보기를 사용할 수 없습니다.';}).catch(()=>{if(!disposed)status.textContent='저장된 규칙을 읽지 못했습니다. 설정을 다시 열어 주세요.';});
  }
  return Object.freeze({ready,sourceRules,setSourceRules,setIgnoredTags:input=>save(input),
    ignoredTags:()=>[...memorySuiteSourceTagPolicy(owner)],mountControls,dispose:()=>{disposed=true;}});
}
// Keep the established LIBRA factory name for existing consumers.
function createLibraSourceInputPolicy(config) { return createMemorySuiteSourceInputPolicy({...config,owner:'libra'}); }
/* END LIBRA SOURCE INPUT POLICY */
