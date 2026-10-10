/* Librarian System Source Edit Consent 1.6.2 / explicit owner-scoped selection
 * Hash-only, owner-scoped journal. Detection never grants permission to analyze.
 * Each iframe owns its own journal/permit and source-review dialog. The legacy
 * SafeDOM fallback is explicit; no other plugin can grant consent for this owner.
 */
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

function memorySuiteSourceEditCauseKind(changeKind) {
  const kinds={
    source_changed:{category:'source_content_changed',ruleIdentifier:'source_projection:visible_content'},
    projection_policy_changed:{category:'projection_policy_changed',ruleIdentifier:'source_rules:change_unidentified'},
    source_and_policy_changed:{category:'source_content_and_policy_changed',ruleIdentifier:'source_projection:content_and_rules'},
    dependency_affected:{category:'upstream_dependency_changed',ruleIdentifier:'source_projection:upstream_dependency'},
    response_variant:{category:'response_variant',ruleIdentifier:'source_projection:known_variant'}
  };
  return kinds[changeKind]||{category:'source_change',ruleIdentifier:'source_projection:unknown'};
}

function memorySuiteSourceEditBoundedDiff(before,after) {
  const next=(value,index)=>{
    const first=value.charCodeAt(index),second=value.charCodeAt(index+1);
    const end=first>=0xD800&&first<=0xDBFF&&second>=0xDC00&&second<=0xDFFF?index+2:index+1;
    return {text:value.slice(index,end),end};
  };
  const previous=(value,end)=>{
    const last=value.charCodeAt(end-1),prior=value.charCodeAt(end-2);
    const start=last>=0xDC00&&last<=0xDFFF&&prior>=0xD800&&prior<=0xDBFF?end-2:end-1;
    return {text:value.slice(start,end),start};
  };
  const count=value=>{let total=0;for(const _ of value)total++;return total;};
  const excerpt=value=>{let end=0,total=0;for(const point of value){if(total++===96)break;end+=point.length;}return {text:value.slice(0,end),truncated:total>96};};
  let beforeStart=0,afterStart=0;
  while(beforeStart<before.length&&afterStart<after.length){
    const a=next(before,beforeStart),b=next(after,afterStart);if(a.text!==b.text)break;beforeStart=a.end;afterStart=b.end;
  }
  let beforeEnd=before.length,afterEnd=after.length;
  while(beforeEnd>beforeStart&&afterEnd>afterStart){
    const a=previous(before,beforeEnd),b=previous(after,afterEnd);if(a.text!==b.text)break;beforeEnd=a.start;afterEnd=b.start;
  }
  const beforePart=before.slice(beforeStart,beforeEnd),afterPart=after.slice(afterStart,afterEnd);
  const beforeSnippet=excerpt(beforePart),afterSnippet=excerpt(afterPart);
  return {beforeSnippet:beforeSnippet.text,afterSnippet:afterSnippet.text,beforeTruncated:beforeSnippet.truncated,afterTruncated:afterSnippet.truncated,
    removedCodePoints:count(beforePart),addedCodePoints:count(afterPart),beforeStart,beforeEnd,afterStart,afterEnd};
}

function memorySuiteMaskLiteralCode(source) {
  const masked=new Uint8Array(source.length),mark=(start,end)=>{
    for(let index=start;index<end;index++)if(source[index]!=='\n'&&source[index]!=='\r')masked[index]=1;
  };
  const lines=[];let offset=0,listContainer='',listContentIndent=0;
  while(offset<source.length){
    const newline=source.indexOf('\n',offset),lineEnd=newline<0?source.length:newline+1;
    const line=source.slice(offset,newline<0?source.length:newline);
    const quote=/^(?: {0,3}> ?)+/.exec(line);
    const list=/^( *)([-+*]|\d+[.)])([ \t]+)(.*)$/.exec(line);
    let logical=line,container='root';
    if(quote){
      logical=line.slice(quote[0].length);container=`quote:${(quote[0].match(/>/g)||[]).length}`;listContainer='';listContentIndent=0;
      if(/^ {0,3}(?:[-+*]|\d+[.)])[ \t]+ {0,3}(?:`{3,}|~{3,})/.test(logical))return null;
    }else if(list){
      if(list[3].includes('\t'))return null;
      const markerColumns=list[2].length,separatorColumns=list[3].length;
      const baseIndent=list[1].length;
      listContentIndent=baseIndent+markerColumns+separatorColumns;listContainer=`list:${baseIndent}:${listContentIndent}`;
      logical=list[4];container=listContainer;
      if(/^ {0,3}> ?(?:`{3,}|~{3,})/.test(logical))return null;
    }else if(listContainer&&(!line.trim()||/^(?: +|\t)/.test(line))){
      const indentation=/^( +)/.exec(line)?.[1].length||0;
      if(line.startsWith('\t'))return null;
      if(indentation<listContentIndent&&!line.trim()){logical='';container=listContainer;}
      else if(indentation<listContentIndent){listContainer='';listContentIndent=0;}
      else{
        logical=line.slice(listContentIndent);container=listContainer;
        if(indentation>=listContentIndent+4)mark(offset,lineEnd);
        if(/^ {0,3}> ?(?:`{3,}|~{3,})/.test(logical))return null;
      }
    }else{listContainer='';listContentIndent=0;}
    if(/^(?: {4,}|\t)/.test(logical))mark(offset,lineEnd);
    lines.push({start:offset,end:lineEnd,logical,container});offset=lineEnd;
  }
  // Match fences after removing Markdown container prefixes. Only the fenced
  // region is masked, so ordinary tags in quoted/list prose remain candidates.
  // An unclosed or context-broken fence conservatively covers the rest.
  let fence=null;
  for(const line of lines){
    const opening=/^ {0,3}(`{3,}|~{3,})/.exec(line.logical);
    if(!fence){
      if(opening){const run=opening[1];fence={character:run[0],length:run.length,start:line.start,container:line.container};}
    }else if(line.container!==fence.container){mark(fence.start,source.length);fence=null;break;}
    else if(opening&&opening[1][0]===fence.character&&opening[1].length>=fence.length
      &&/^[ \t]*$/.test(line.logical.slice(opening[0].length))){
      mark(fence.start,line.end);fence=null;
    }
  }
  if(fence)mark(fence.start,source.length);

  // Inline code spans use equal-length backtick runs and may span lines, but
  // never cross a fenced block boundary.
  for(let index=0;index<source.length;){
    if(masked[index]||source[index]!=='`'){index++;continue;}
    let runEnd=index+1;while(runEnd<source.length&&source[runEnd]==='`')runEnd++;
    const runLength=runEnd-index;
    let close=-1;
    for(let cursor=runEnd;cursor<source.length;){
      if(masked[cursor])break;
      if(source[cursor]!=='`'){cursor++;continue;}
      let candidateEnd=cursor+1;while(candidateEnd<source.length&&source[candidateEnd]==='`'&&!masked[candidateEnd])candidateEnd++;
      if(candidateEnd-cursor===runLength){close=candidateEnd;break;}
      cursor=candidateEnd;
    }
    if(close>0){mark(index,close);index=close;}else index=runEnd;
  }

  // HTML pre/code contents are literal as well. Malformed nesting is ambiguous,
  // so fail closed for all optional wrapper suggestions on that body.
  const htmlTag=/<\/?(pre|code)\b(?:"[^"]*"|'[^']*'|[^'">])*?>/gi,stack=[];
  for(const match of source.matchAll(htmlTag)){
    const start=match.index,end=start+match[0].length;
    if(masked[start])continue;
    const name=match[1].toLowerCase(),closing=match[0][1]==='/',selfClosing=/\/\s*>$/.test(match[0]);
    if(!closing){if(!selfClosing)stack.push({name,start});continue;}
    const open=stack.pop();if(!open||open.name!==name)return null;
    if(!stack.length)mark(open.start,end);
  }
  if(stack.length)return null;
  let output='';
  for(let index=0;index<source.length;index++)output+=masked[index]&&source[index]!=='\n'&&source[index]!=='\r'?' ':source[index];
  return output;
}

function memorySuiteSourceEditWrapperCandidates(source) {
  const MAX_REVIEW_CHARS=32768,MAX_TAG_NAMES=24,MAX_MARKERS=96,MAX_WRAPPERS=24;
  if(typeof source!=='string'||source.length>MAX_REVIEW_CHARS)return null;
  source=memorySuiteMaskLiteralCode(source);if(source===null)return null;
  const wrappers=new Map(),add=wrapper=>{
    if(!wrapper?.open||!wrapper?.close)return true;
    wrappers.set(JSON.stringify(wrapper),wrapper);return wrappers.size<=MAX_WRAPPERS;
  };
  const names=new Set();
  for(const match of source.matchAll(/<\/?([a-z][a-z0-9:_-]*)(?=[\s/>])(?:"[^"]*"|'[^']*'|[^'">])*?>/gi)){
    names.add(match[1].toLowerCase());if(names.size>MAX_TAG_NAMES)return null;
  }
  for(const name of names){
    const parsed=memorySuiteSourceTagRanges(source,[name]);if(parsed.invalid)continue;
    for(const range of parsed.ranges){
      if(!add({open:source.slice(range.start,range.innerStart),close:source.slice(range.innerEnd,range.end)}))return null;
    }
  }
  const markers=[];const markerPattern=/\[[^\]\r\n]{1,256}\]/g;let marker;
  while((marker=markerPattern.exec(source))){markers.push({text:marker[0],index:marker.index});if(markers.length>MAX_MARKERS)return null;}
  const lastIndexByText=new Map();for(const item of markers)lastIndexByText.set(item.text,item.index);
  for(const opening of markers){
    if(/^\[\/[^\]]+\]$/.test(opening.text))continue;
    const name=opening.text.slice(1,-1),expected=[];
    if(name&&!/[\r\n]/.test(name))expected.push('[/'+name+']');
    const start=/^(.{1,120})\s+START$/i.exec(name);
    if(start)expected.push('['+start[1]+' END]');
    if(/^OPEN$/i.test(name))expected.push('[CLOSE]');
    for(const close of expected){
      const last=lastIndexByText.get(close);
      if(last!==undefined&&last>opening.index&&!add({open:opening.text,close}))return null;
    }
  }
  for(const [key,wrapper] of wrappers){
    const parsed=memorySuiteLiteralRanges(source,[wrapper]);
    if(parsed.invalid||!parsed.ranges.length)wrappers.delete(key);
  }
  return wrappers;
}

function memorySuiteSourceEditRuleException(before,after,owner) {
  try {
  // Avoid spending before-request time on unusually large review bodies. Cause
  // diffs are still recorded; only the optional rule shortcut is omitted.
  const beforeWrappers=memorySuiteSourceEditWrapperCandidates(before),afterWrappers=memorySuiteSourceEditWrapperCandidates(after);
  if(!beforeWrappers||!afterWrappers)return null;
  const uniqueWrappers=[...beforeWrappers].filter(([key])=>afterWrappers.has(key)).map(([,value])=>value),candidates=[];
  if(uniqueWrappers.length>24)return null;
  const base=memorySuiteExternalSourceRules(memorySuiteSourceRules(owner)||memorySuiteDefaultSourceRules(owner));
  for(const wrapper of uniqueWrappers)for(const category of ['ignoredTags','unwrapTags','sourceTags']){
    try{
      if(memorySuiteIsInternalSourceRule(wrapper))continue;
      const candidate=memorySuiteNormalizeSourceEntries([wrapper],category)[0];
      if(memorySuiteIsInternalSourceRule(candidate)||candidate==='dag_runtime_contract')continue;
      if(base[category].some(rule=>JSON.stringify(rule)===JSON.stringify(candidate)))continue;
      const input={...base,[category]:[...base[category],candidate]};
      const rules=memorySuiteNormalizeSourceRules(input);
      const oldProjection=memorySuiteProjectSourceRules(memorySuiteStripInternalSource(before),rules);
      const newProjection=memorySuiteProjectSourceRules(memorySuiteStripInternalSource(after),rules);
      if(!oldProjection.warnings.length&&!newProjection.warnings.length&&oldProjection.text===newProjection.text)
        candidates.push({category,wrapper});
    }catch(_){/* Invalid, conflicting, or internal candidates are omitted individually. */}
  }
  const unique=[...new Map(candidates.map(value=>[JSON.stringify(value),value])).values()];
  // More than one valid category/wrapper is ambiguous. The UI then offers the
  // existing rule editor and the revision-scoped exception without guessing.
  return unique.length===1?unique[0]:null;
  }catch(_){return null;}
}

function memorySuiteSourceEditCause(changeKind,row,unavailableReason='review_unavailable',owner) {
  const kind=memorySuiteSourceEditCauseKind(changeKind);
  const cause={schema:'memory-suite.source-edit-cause.v1',status:'unavailable',...kind,changeKind,diffAvailable:false};
  // A rule-only rebuild has a concrete cause but no source-text change to show.
  if(changeKind==='projection_policy_changed')return {...cause,status:'available',reason:'source_rules_changed'};
  if(!row)return {...cause,reason:unavailableReason};
  if(row.currentValid!==true)return {...cause,reason:'current_source_unverified'};
  if(row.previousUnavailable===true)return {...cause,reason:'previous_source_unavailable'};
  if(typeof row.beforeText!=='string'||typeof row.afterText!=='string')return {...cause,reason:'review_text_unavailable'};
  const diff=memorySuiteSourceEditBoundedDiff(row.beforeText,row.afterText);
  if(!diff.removedCodePoints&&!diff.addedCodePoints)return {...cause,reason:'no_projected_text_difference'};
  let exceptionRule=null;
  try{exceptionRule=memorySuiteSourceEditRuleException(row.beforeText,row.afterText,owner);}catch(_){/* Optional diagnosis must not block automatic reconciliation. */}
  return {schema:cause.schema,status:'available',...kind,changeKind,diffAvailable:true,
    beforeExcerpt:diff.beforeSnippet,afterExcerpt:diff.afterSnippet,beforeTruncated:diff.beforeTruncated,
    afterTruncated:diff.afterTruncated,removedCodePoints:diff.removedCodePoints,addedCodePoints:diff.addedCodePoints,
    ...(exceptionRule?{exceptionRule}:{})};
}

function createMemorySuiteSourceEditConsent(config) {
  'use strict';
  const SCHEMA = 'memory-suite.source-edit-consent.v1';
  const QUESTION = '원문은 자동으로 검사하지 않습니다. 필요한 구간을 선택해 미리보기 후 직접 재분석하세요.';
  const clone = v => JSON.parse(JSON.stringify(v));
  const scopes = new Map(), permits = new Map();
  const controlObservers = new Set();
  let disposed = false, polling = null, reviewing = false, explicitWork = null;
  let explicitPreview = null, previewSerial = 0;
  let currentScope = '', lastError = '', lastReview = null, dialogClose = null;
  // Preferences are owner-owned and separate from source evidence and task journals.
  const boundary = config.requestBoundary === true;
  let preferences = null, preferenceLoad = null, modeChanging = false, generation = 0, requestScope = '', trackingError = '';
  let tagSave=null;
  let requestGeneration=0;
  const preferenceKey = '__source_tracking_preferences_v1__';
  const readPreferences=()=>config.readPreferences?config.readPreferences():config.read(preferenceKey);
  const writePreferences=body=>config.writePreferences?config.writePreferences(body):config.write(preferenceKey,body);
  // Historical mode values are read-compatible only. Loading never rewrites settings.
  const mode = () => 'explicit_only';
  async function loadPreferences() {
    if (preferences) return preferences;
    if (!preferenceLoad) preferenceLoad = (async()=>{
      const raw=await readPreferences();
      const value=raw==null||raw===''?{mode:'explicit_only',epoch:0}:typeof raw==='string'?JSON.parse(raw):clone(raw);
      if(value.sourceRuleEpoch===undefined)value.sourceRuleEpoch=0;
      if(!['auto','notify','silent','off','explicit_only'].includes(value.mode)||!Number.isSafeInteger(value.epoch)||value.epoch<0)throw Error('SOURCE_TRACKING_PREFERENCES_INVALID');
      if(!Number.isSafeInteger(value.sourceRuleEpoch)||value.sourceRuleEpoch<0)throw Error('SOURCE_TRACKING_RULE_EPOCH_INVALID');
      value.mode='explicit_only';
      value.ignoredTags=memorySuiteSourceIgnoredTags(value.ignoredTags);
      if(value.sourceRules)value.sourceRules=memorySuiteExternalSourceRules(memorySuiteNormalizeSourceRules(value.sourceRules),value.externalRulesVersion!==1);
      value.ignoredTags=value.ignoredTags.filter(x=>!memorySuiteIsInternalSourceRule(x)&&!(value.externalRulesVersion!==1&&x==='dag_runtime_contract'));
      value.externalRulesVersion=1;
      preferences=value;memorySuiteSourceTagPolicy(config.owner,value.ignoredTags);memorySuiteSourceRules(config.owner,value.sourceRules||null);return value;
    })().finally(()=>{preferenceLoad=null;});
    return preferenceLoad;
  }
  async function setMode(next) {
    if(!['auto','notify','silent','off','explicit_only'].includes(next))throw Error('SOURCE_TRACKING_MODE_INVALID');
    // Compatibility cannot restart the observer; an old mode action revokes any current ticket.
    cancelSelected();await loadPreferences();return status();
  }
  function beginRequest() {
    if(!boundary)return;
    explicitPreview=null;requestScope='__pending__';return ++requestGeneration;
  }
  function sourceRules(){return clone(memorySuiteSourceRules(config.owner)||memorySuiteDefaultSourceRules(config.owner));}
  function setSourceRules(input) {
    if(tagSave)return Promise.reject(Error('SOURCE_IGNORE_TAGS_BUSY'));
    const work=writeIgnoredTags(null,input);tagSave=work;
    return work.finally(()=>{if(tagSave===work)tagSave=null;});
  }
  function setIgnoredTags(input) {
    if(tagSave)return Promise.reject(Error('SOURCE_IGNORE_TAGS_BUSY'));
    const work=writeIgnoredTags(input);tagSave=work;
    return work.finally(()=>{if(tagSave===work)tagSave=null;});
  }
  async function writeIgnoredTags(input,ruleInput) {
    const proposed=ruleInput===undefined?null:memorySuiteNormalizeSourceRules(ruleInput);
    if(proposed&&([...proposed.ignoredTags,...proposed.unwrapTags,...proposed.sourceTags].some(memorySuiteIsInternalSourceRule)||proposed.controls.includes('suite-blocks')))throw Error('SOURCE_RULES_INTERNAL: Suite 자체 운용 표식은 내부에서 처리합니다.');
    const ignoredTags=(proposed?proposed.ignoredTags.filter(x=>typeof x==='string'):memorySuiteSourceIgnoredTags(input)).filter(x=>!memorySuiteIsInternalSourceRule(x));
    if(modeChanging||reviewing||permits.size||requestScope||config.busy?.()===true)throw Error('SOURCE_IGNORE_TAGS_BUSY: 현재 요청·처리가 끝난 뒤 저장하세요.');
    modeChanging=true;generation++;
    try {
      await loadPreferences();if(polling)await polling;
      const rules=proposed||(preferences.sourceRules?memorySuiteNormalizeSourceRules({...preferences.sourceRules,ignoredTags}):null);
      const previousPolicy=JSON.stringify({ignoredTags:preferences.ignoredTags,sourceRules:preferences.sourceRules||null});
      const nextPolicy=JSON.stringify({ignoredTags,sourceRules:rules||null});
      const policyChanged=previousPolicy!==nextPolicy;
      const desired={...preferences,ignoredTags,...(rules?{sourceRules:rules}:{}),sourceRuleEpoch:Number(preferences.sourceRuleEpoch||0)+(policyChanged?1:0)},body=JSON.stringify(desired);
      if(await writePreferences(body)===false)throw Error('SOURCE_TRACKING_WRITE_REJECTED');
      const raw=await readPreferences();if((typeof raw==='string'?raw:JSON.stringify(raw))!==body)throw Error('SOURCE_TRACKING_READBACK_FAILED');
      preferences=desired;memorySuiteSourceTagPolicy(config.owner,ignoredTags);memorySuiteSourceRules(config.owner,rules);trackingError='';lastError='';
      dialogClose?.();config.closeReview?.();return status();
    }catch(error){trackingError=lastError=String(error?.message||error);throw error;}
    finally{modeChanging=false;safeNotify();}
  }
  async function beforeRequest(snapshot = null) {
    beginRequest();await loadPreferences();
    // Admission only invalidates explicit tickets; no source or journal observation.
    return status();
  }
  function afterRequest() {
    if(!requestScope)return;
    requestScope='';
  }
  function mountControls(container) {
    if(!container?.ownerDocument)return;
    if(container.querySelector('[data-source-tracking-controls]'))return;
    const doc=container.ownerDocument,box=doc.createElement('div'),note=doc.createElement('p');
    box.dataset.sourceTrackingControls=config.owner;box.append(note);container.prepend(box);
    const inspectButton=doc.createElement('button');inspectButton.type='button';inspectButton.textContent='원문 구간 조회';box.append(inspectButton);
    inspectButton.onclick=async()=>{
      if(inspectButton.disabled||requestScope||explicitWork||config.busy?.()===true)return;
      inspectButton.disabled=true;cancelSelected();
      try{await refresh({phase:'view',prompt:false});safeNotify();}finally{inspectButton.disabled=false;}
    };
    const fields={},tagStatus=doc.createElement('p'),style=doc.createElement('style');
    box.className='ms-source-settings';
    style.textContent=`
.ms-source-settings{font:14px/1.6 system-ui,-apple-system,'Malgun Gothic',sans-serif;color:inherit;display:grid;gap:16px;max-width:960px;margin:0 auto 24px;width:100%;box-sizing:border-box}
.ms-source-settings *{box-sizing:border-box}.ms-source-settings p{margin:0}.ms-source-settings h3{font:700 16px/1.5 system-ui;margin:0}.ms-source-settings label{display:grid;gap:8px;font-weight:600}
.ms-source-settings select,.ms-source-settings input{font:inherit;color:inherit;background:transparent;border:1px solid #8887;border-radius:10px;padding:10px 12px;min-width:0}
.ms-source-settings button{font:inherit;color:inherit;cursor:pointer;min-height:40px;padding:8px 14px;border:1px solid #8887;border-radius:10px;background:transparent}.ms-source-settings button:disabled{opacity:.5;cursor:default}.ms-source-settings button:focus-visible,.ms-source-settings input:focus-visible{outline:2px solid currentColor;outline-offset:2px}
.ms-source-settings .ms-rule-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.ms-source-settings .ms-rule-card{border:1px solid #8885;border-radius:14px;padding:18px;display:grid;gap:12px;background:#88888808}.ms-source-settings .ms-rule-desc{opacity:.8;font-size:13px}.ms-source-settings .ms-rule-chips{display:flex;gap:8px;flex-wrap:wrap;max-height:180px;overflow:auto}.ms-source-settings .ms-rule-chip{display:inline-flex;align-items:center;gap:8px;max-width:100%;padding:4px 8px 4px 12px;border:1px solid #8885;border-radius:20px;background:#8881;overflow-wrap:anywhere;font-size:13px}.ms-source-settings .ms-rule-chip button{padding:2px 6px;min-height:32px;font-size:13px}
.ms-source-settings .ms-source-history{display:grid;gap:10px}.ms-source-settings .ms-source-event{border:1px solid #8885;border-radius:12px;padding:12px;display:grid;gap:8px}.ms-source-settings .ms-source-event-actions{display:flex;flex-wrap:wrap;gap:8px}.ms-source-settings .ms-source-event pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:320px;overflow:auto}
.ms-source-settings .ms-rule-add{display:grid;gap:8px}.ms-source-settings .ms-rule-add input{width:100%}.ms-source-settings .ms-rule-add label{font-size:12px;font-weight:500}.ms-source-settings .ms-rule-add button{justify-self:end}.ms-source-settings .ms-rule-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.ms-source-settings .ms-rule-save{background:#345e68;color:white;border-color:#345e68;font-weight:700}.ms-source-settings[data-source-tracking-controls=libra] .ms-rule-save{background:#79522d;border-color:#79522d}.ms-source-settings details{border-top:1px solid #8884;padding-top:12px}.ms-source-settings summary{cursor:pointer;font-weight:600}.ms-source-settings details p{margin-top:10px}
@media(max-width:760px){.ms-source-settings .ms-rule-grid{grid-template-columns:1fr}}
@media(max-width:480px){.ms-source-settings .ms-rule-card{padding:14px}.ms-source-settings .ms-rule-actions button{flex:1}.ms-source-settings .ms-rule-add button{padding:8px 12px}}
`;
    box.prepend(style);
    const title=doc.createElement('h3');title.textContent='직접 원문 재분석';box.insertBefore(title,note);
    const history=doc.createElement('section'),historyTitle=doc.createElement('h3'),historyList=doc.createElement('div');
    history.className='ms-source-history';historyTitle.textContent='선택한 원문과 처리 내역';history.append(historyTitle,historyList);box.append(history);
    const selected=new Set();let selectionScope='',selectionTicket=null,selectionBusy=false,selectionProofGeneration=-1;
    const explicitActions=doc.createElement('div'),previewButton=doc.createElement('button'),applyButton=doc.createElement('button'),selectionStatus=doc.createElement('p');
    previewButton.type=applyButton.type='button';previewButton.textContent='선택 원문 갱신 미리보기';applyButton.textContent='선택 원문 갱신 실행';applyButton.disabled=true;applyButton.dataset.sourceAction='explicit_apply';applyButton.dataset.sourceActionReady='false';
    selectionStatus.setAttribute('role','status');explicitActions.className='ms-source-event-actions';
    if(config.owner==='flashback'){explicitActions.append(previewButton,applyButton);history.append(explicitActions,selectionStatus);}
    const forgetSelectionProof=()=>{selectionTicket=null;selectionProofGeneration=-1;applyButton.disabled=true;applyButton.dataset.sourceActionReady='false';};
    previewButton.onclick=async()=>{
      if(selectionBusy||!box.isConnected)return;selectionBusy=true;forgetSelectionProof();previewButton.disabled=true;
      const selectedKeys=[...selected],selectedScope=selectionScope;renderHistory();
      try{const ticket=await (config.recoveryActions?config.recoveryActions().preview('explicit_reanalysis',selectedKeys):previewSelected(selectedKeys));
        if(!box.isConnected||selectedScope!==selectionScope||JSON.stringify([...selected].sort())!==JSON.stringify(selectedKeys.sort()))return;
        selectionTicket=ticket;selectionProofGeneration=generation;applyButton.disabled=!selectionTicket.allowed;applyButton.dataset.sourceActionReady=selectionTicket.allowed?'true':'false';
        selectionStatus.textContent=selectionTicket.allowed?selectionTicket.units.map(u=>u.label||'T'+u.start).join(', ')+' · '+selectionTicket.warning:'미리보기를 만들지 못했습니다. 현재 범위와 선택 구간을 다시 확인하세요.';
      }catch(error){selectionStatus.textContent=String(error?.message||error);}finally{selectionBusy=false;previewButton.disabled=false;renderHistory();}
    };
    applyButton.onclick=async()=>{
      if(selectionBusy||!box.isConnected||!selectionTicket?.allowed)return;selectionBusy=true;applyButton.disabled=previewButton.disabled=true;applyButton.dataset.sourceActionReady='false';
      const ticket=selectionTicket;selectionTicket=null;
      try{const result=await (config.recoveryActions?config.recoveryActions().apply(ticket):applySelected(ticket));selectionStatus.textContent=result.ok?'선택 원문 갱신과 저장 확인이 완료되었습니다.':'원문 갱신을 완료하지 못했습니다. 새 미리보기 후 확인하세요. '+result.reason;
        if(result.ok)selected.clear();
      }catch(error){selectionStatus.textContent=String(error?.message||error);}finally{selectionBusy=false;previewButton.disabled=false;renderHistory();}
    };
    const renderHistory=()=>{
      const view=status(),events=view.events||[];historyList.replaceChildren();
      if(selectionTicket&&selectionProofGeneration!==generation){forgetSelectionProof();selectionStatus.textContent='이전 미리보기가 만료되었습니다. 새 미리보기 후 실행하세요.';}
      if(selectionScope!==view.scopeKey){selectionScope=view.scopeKey;selected.clear();forgetSelectionProof();}

      const seen=new Set(events.map(event=>event.revisionId));
      const rows=[...events.map(event=>({event,task:view.tasks.find(task=>task.revisionId===event.revisionId)})),
        ...view.tasks.filter(task=>!seen.has(task.revisionId)&&(task.excluded||['awaiting_consent','declined','failed','conflict','interrupted'].includes(task.state))).map(task=>({event:null,task}))];
      if(!rows.length){const empty=doc.createElement('p');empty.textContent='원문 구간을 직접 조회한 뒤 필요한 구간을 선택하세요.';historyList.append(empty);return;}
      for(const {event,task} of rows){
        const item=doc.createElement('div'),heading=doc.createElement('strong'),detail=doc.createElement('p'),actions=doc.createElement('div');
        item.className='ms-source-event';actions.className='ms-source-event-actions';
        const kind=task?.changeKind||event?.changeKind;
        const kindLabel=kind==='projection_policy_changed'?'표식 규칙 변경으로 재분석':kind==='source_and_policy_changed'?'원문 및 표식 규칙 변경':kind==='source_changed'?'원문 수정 확인':'';
        const cause=task?.cause||event?.cause;
        const causeLabel=({source_content_changed:'원문 내용 변경',projection_policy_changed:'표식 규칙 변경',
          source_content_and_policy_changed:'원문 내용 및 규칙 변경',upstream_dependency_changed:'앞선 원문 변경에 따른 영향',
          response_variant:'이미 확인된 응답 버전',source_change:'원문 변경'})[cause?.category]||'';
        const stateLabel=task?.excluded?'예외 지정':task?.stateLabel||event?.state||'처리 기록';
        heading.textContent=(event?.label||task?.label||'수정 항목')+' · '+(kindLabel?kindLabel+' · ':'')+stateLabel;
        if(cause?.diffAvailable){
          const rule=cause.exceptionRule,ruleType=({ignoredTags:'비교 제외',unwrapTags:'표식 제거',sourceTags:'원문 영역 지정'})[rule?.category]||'예외 규칙';
          const ruleDetail=rule?` · 검증된 예외 규칙 후보 (${ruleType}): ${rule.wrapper.open} … ${rule.wrapper.close}`:'';
          detail.textContent='비교 결과: '+(causeLabel||'원문 변경')+ruleDetail;
        }
        else if(task?.error)detail.textContent=task.error;
        else if(task?.originalEvidenceUnavailable||event?.originalEvidenceUnavailable)detail.textContent='이전 원문 비교 자료가 없어 이전·현재 diff는 표시하지 않습니다. 현재 원문을 확인한 뒤 선택 구간만 직접 갱신할 수 있습니다.';
        else if(task?.policyUncertain||event?.policyUncertain)detail.textContent='이전 원문 증거를 확인할 수 없어 현재 원문을 새 규칙으로 다시 처리합니다. 원문 수정 diff는 표시하지 않습니다.';
        else if(cause?.status==='unavailable')detail.textContent=({current_source_unverified:'현재 원문을 확인하지 못해 변경 구간을 표시하지 않습니다.',
          previous_source_unavailable:'이전 원문 비교 자료를 사용할 수 없어 변경 구간을 표시하지 않습니다.',review_unavailable:'원문 비교 자료를 불러오지 못해 변경 구간을 표시하지 않습니다.',
          review_row_unavailable:'원문 비교 자료가 불완전해 변경 구간을 표시하지 않습니다.',review_text_unavailable:'원문 텍스트를 사용할 수 없어 변경 구간을 표시하지 않습니다.'})[cause.reason]||'원문 비교 자료를 사용할 수 없어 변경 구간을 표시하지 않습니다.';
        else if(cause?.reason==='source_rules_changed')detail.textContent='원문 본문 비교 없이 저장된 표식 규칙 변경을 적용합니다.';
        else detail.textContent=!event?'직접 조회한 원문 구간입니다.':'명시적 원문 작업 내역입니다.';
        item.append(heading,detail,actions);
        if(cause?.diffAvailable){
          const excerpt=doc.createElement('pre'),beforeSuffix=cause.beforeTruncated?'… (일부 생략)':'',afterSuffix=cause.afterTruncated?'… (일부 생략)':'';
          excerpt.textContent=`변경 전 (${cause.removedCodePoints}자)\n${cause.beforeExcerpt}${beforeSuffix}\n\n변경 후 (${cause.addedCodePoints}자)\n${cause.afterExcerpt}${afterSuffix}`;item.append(excerpt);
        }
        if(config.owner==='flashback'&&task&&!task.historicalView&&!task.excluded&&!task.conflict&&!task.archived&&['awaiting_consent','declined','failed','interrupted'].includes(task.state)){
          const selectLabel=doc.createElement('label'),checkbox=doc.createElement('input');checkbox.type='checkbox';checkbox.checked=selected.has(task.key);checkbox.disabled=selectionBusy;
          checkbox.setAttribute('aria-label',(task.label||'T'+task.start)+' 원문 갱신 선택');checkbox.onchange=()=>{if(selectionBusy){checkbox.checked=selected.has(task.key);return;}checkbox.checked?selected.add(task.key):selected.delete(task.key);forgetSelectionProof();};
          selectLabel.append(checkbox,doc.createTextNode('이 구간 선택'));actions.prepend(selectLabel);
        }
        if(task?.revisionId){
          const toggle=doc.createElement('button');toggle.type='button';toggle.textContent=task.excluded?'예외 해제':'예외 지정';
          toggle.onclick=async()=>{await setException(view.scopeKey,task.key,task.revisionId,!task.excluded);renderHistory();};actions.append(toggle);
          if(event&&cause?.exceptionRule&&['ignoredTags','unwrapTags','sourceTags'].includes(cause.exceptionRule.category)){
            const tagException=doc.createElement('button');tagException.type='button';
            tagException.textContent=({ignoredTags:'비교 제외 규칙에 추가',unwrapTags:'표식 제거 규칙에 추가',sourceTags:'원문 영역 태그에 추가'})[cause.exceptionRule.category];
            tagException.onclick=async()=>{
              tagException.disabled=true;
              try{
                const rules=sourceRules(),category=cause.exceptionRule.category;
                const proposed=memorySuiteNormalizeSourceRules({...rules,[category]:[...rules[category],cause.exceptionRule.wrapper]});
                if(JSON.stringify(proposed)!==JSON.stringify(rules))await setSourceRules(proposed);
                tagStatus.textContent='태그 규칙을 저장하고 읽어 확인했습니다. 다음 명시적 원문 조회·재분석에 저장한 규칙을 적용합니다.';
                renderHistory();
              }catch(error){tagStatus.textContent='태그 예외 저장 실패: '+String(error?.message||error);tagException.disabled=false;}
            };actions.append(tagException);
          }
          if(event&&kind!=='projection_policy_changed'&&!task?.policyUncertain&&typeof config.loadReview==='function'){
            const compare=doc.createElement('button');compare.type='button';compare.textContent='원문 비교';
            compare.onclick=async()=>{const output=doc.createElement('pre');output.textContent='원문을 불러오는 중…';item.append(output);
              try{const reviewSet=await config.loadReview([clone(task)],view.scopeKey),row=reviewSet?.rows?.find(row=>row.key===task.key);
                output.textContent=row?`이전 원문\n${row.previousUnavailable?'이전 전체 원문 없음':row.beforeText||''}\n\n현재 원문\n${row.afterText||''}`:'비교할 원문을 찾지 못했습니다.';
              }catch(error){output.textContent='원문 비교 실패: '+String(error?.message||error);}};actions.append(compare);
          }
        }
        if(event){const remove=doc.createElement('button');remove.type='button';remove.textContent='내역 삭제';remove.onclick=async()=>{await deleteEvent(view.scopeKey,event.id);renderHistory();};actions.append(remove);}
        historyList.append(item);
      }
    };
    const controlLabels={'@html-comment':'HTML 주석','@lbdata':'LBDATA 제어 블록','@suite-blocks':'Suite 기억·패킷 블록','@inlay':'삽화 호출'};
    const draft={ignoredTags:[],unwrapTags:[],sourceTags:[]};let loaded=false;
    const read=()=>memorySuiteNormalizeSourceRules(draft);
    const changed=()=>{tagStatus.textContent='변경한 규칙을 저장해 주세요.';};
    const render=(key)=>{
      const {list}=fields[key];list.replaceChildren();
      if(!draft[key].length){const empty=doc.createElement('span');empty.className='ms-rule-desc';empty.textContent='등록된 태그 없음';list.append(empty);}
      for(const value of draft[key]){
        const chip=doc.createElement('span'),name=doc.createElement('span'),edit=doc.createElement('button'),remove=doc.createElement('button');chip.className='ms-rule-chip';const form=memorySuiteSourceRuleForm(value);name.textContent=form.open+' → '+(form.close||'단일 표식');chip.title=typeof value==='string'?(controlLabels[value]||value):name.textContent;
        edit.type='button';edit.disabled=!loaded;edit.textContent='수정';edit.setAttribute('aria-label',name.textContent+' 수정');edit.onclick=()=>{const field=fields[key];field.input.value=form.open;field.closeInput.value=form.close;field.editingValue=value;field.add.textContent='수정 적용';field.input.focus();};
        remove.type='button';remove.disabled=!loaded;remove.textContent='×';remove.setAttribute('aria-label',name.textContent+' 삭제');remove.onclick=()=>{draft[key]=draft[key].filter(x=>x!==value);render(key);changed();};chip.append(name,edit,remove);list.append(chip);
      }
    };
    const cards=doc.createElement('div');cards.className='ms-rule-grid';box.append(cards);
    for(const [key,title,description,example]of [
      ['sourceTags','원문이 들어 있는 태그','GigaTrans 사용자를 위한 고급 기능입니다. 원문이 들어있는 태그를 지정하면 이 태그 바깥의 변경(번역문)은 무시합니다.','예: original'],
      ['ignoredTags','비교에서 빼고 싶은 내용','일반적인 태그 제거 기능입니다. 특정 모듈, 플러그인이 사용하는 태그를 지정하면 해당 태그를 무시합니다.','예: decoration'],
      ['unwrapTags','내용은 두고 태그만 제거','태그 안에 실제 본문이 들어있는 경우 사용합니다. 원문이 들어있는 태그와의 차이는 태그 밖의 내용을 무시하지 않는다는 점입니다. 본문 내용을 특정 태그로 감싸는 경우 사용하세요.','예: wrapper']]){
      const card=doc.createElement('section'),heading=doc.createElement('h3'),desc=doc.createElement('p'),list=doc.createElement('div'),row=doc.createElement('div'),input=doc.createElement('input'),closeInput=doc.createElement('input'),add=doc.createElement('button');
      card.className='ms-rule-card';card.dataset.sourceRule=key;heading.textContent=title;desc.className='ms-rule-desc';desc.textContent=description;list.className='ms-rule-chips';row.className='ms-rule-add';
      for(const [field,fieldTitle,placeholder]of [[input,'여는 표식',key==='sourceTags'?'<original>':key==='unwrapTags'?'<wrapper>':'[LBDATA START]'],[closeInput,'닫는 표식',key==='sourceTags'?'</original>':key==='unwrapTags'?'</wrapper>':'[LBDATA END]']]){const label=doc.createElement('label');label.textContent=fieldTitle;field.type='text';field.placeholder=placeholder;field.setAttribute('aria-label',title+' '+fieldTitle);field.disabled=true;label.append(field);row.append(label);}
      if(key!=='sourceTags'){const single=doc.createElement('small');single.textContent='단일 표식은 닫는 칸을 비워 두세요.';row.append(single);}
      add.type='button';add.disabled=true;add.textContent='추가';
      const insert=()=>{if(!loaded)return;const value={open:input.value,close:closeInput.value};if(!value.open.trim())return;const old=draft[key],editing=fields[key].editingValue;try{draft[key]=editing?old.map(item=>item===editing?value:item):[...old,value];read();fields[key].editingValue=null;add.textContent='추가';input.value=closeInput.value='';render(key);changed();input.focus();}catch(e){draft[key]=old;tagStatus.textContent=String(e.message||e);}};
      add.onclick=insert;for(const field of [input,closeInput])field.onkeydown=e=>{if(e.key==='Enter'&&!e.isComposing){e.preventDefault();insert();}};fields[key]={list,input,closeInput,add};row.append(add);card.append(heading,desc,list,row);cards.append(card);
    }
    const help=doc.createElement('details'),summary=doc.createElement('summary'),details=doc.createElement('p');summary.textContent='표식은 어떻게 입력하나요?';details.textContent='여는 표식과 닫는 표식을 실제 본문에 나오는 전체 형태로 입력하세요. 예: <original> / </original>, [LBDATA START] / [LBDATA END]. 일반 표식은 대소문자와 공백을 구분하여 그대로 찾습니다. 표준 <태그> / </태그> 쌍은 속성과 대소문자를 기존처럼 처리합니다. 각 최대 128개, 표식당 256자입니다. 원문 선택에는 닫는 표식이 필요합니다. 다른 두 작업은 닫는 칸을 비워 단일 표식을 제거할 수 있습니다. 외부 모듈의 기본 규칙은 삭제할 수 있습니다. Suite 자체 운용 표식은 이 목록에서 관리하지 않습니다. 원문 선택 → 내용 제외 → 표식 제거 순서로 적용합니다. 기존 채팅과 기억은 설정 저장만으로 덮어쓰지 않습니다.';help.append(summary,details);
    const hint=doc.createElement('p');hint.className='ms-rule-desc';hint.textContent='외부 규칙을 비우면 본문 전체를 비교합니다. Suite 자체 운용 표식은 별도로 처리합니다. 규칙 변경은 아래 저장 버튼을 눌러야 적용됩니다.';
    const actions=doc.createElement('div'),saveTags=doc.createElement('button'),clear=doc.createElement('button');actions.className='ms-rule-actions';saveTags.type=clear.type='button';saveTags.className='ms-rule-save';saveTags.textContent='규칙 저장';clear.textContent='모든 규칙 비우기';saveTags.disabled=clear.disabled=true;
    clear.onclick=()=>{for(const key of Object.keys(draft)){draft[key]=[];fields[key].input.value=fields[key].closeInput.value='';fields[key].editingValue=null;fields[key].add.textContent='추가';render(key);}changed();};
    const fill=()=>{const r=sourceRules();draft.ignoredTags=[...r.ignoredTags,...r.controls.map(x=>'@'+x)];draft.unwrapTags=[...r.unwrapTags];draft.sourceTags=[...r.sourceTags];for(const key of Object.keys(draft)){fields[key].editingValue=null;fields[key].add.textContent='추가';render(key);}};
    saveTags.onclick=async()=>{saveTags.disabled=clear.disabled=true;cards.querySelectorAll('input,button').forEach(n=>{n.disabled=true;});try{if(Object.values(fields).some(f=>f.input.value.trim()||f.closeInput.value.trim()))throw Error('입력 중인 태그의 추가 버튼을 먼저 눌러 주세요.');await setSourceRules(read());fill();tagStatus.textContent='규칙을 저장했습니다.';}catch(e){tagStatus.textContent='저장 실패: '+String(e.message||e);}finally{saveTags.disabled=clear.disabled=false;cards.querySelectorAll('input,button').forEach(n=>{n.disabled=false;});}};
    tagStatus.setAttribute('role','status');tagStatus.setAttribute('aria-live','polite');actions.append(saveTags,clear);box.append(hint,actions,tagStatus,help);
    fill();loadPreferences().then(()=>{loaded=true;fill();for(const f of Object.values(fields)){f.input.disabled=f.closeInput.disabled=f.add.disabled=false;}saveTags.disabled=clear.disabled=false;}).catch(e=>{tagStatus.textContent=String(e.message||e);});
    const update=()=>{note.textContent=QUESTION;renderHistory();};
    controlObservers.add({node:box,update});
    loadPreferences().then(update).catch(e=>{note.textContent=String(e.message||e);});update();
  }
  const now = () => typeof config.now === 'function' ? config.now() : Date.now();
  const safeNotify = () => { for(const item of controlObservers){try{if(item.node.isConnected)item.update();else controlObservers.delete(item);}catch(_){controlObservers.delete(item);}} try { config.onChange?.(status()); } catch (_) {} };
  const getScope = key => {
    if (!scopes.has(key)) scopes.set(key, { key, data: null, load: null, save: Promise.resolve(), units: new Map(), error: '', observedAt: 0 });
    return scopes.get(key);
  };
  const empty = key => ({ schema: SCHEMA, owner: config.owner, scopeKey: key, tasks: {}, events: [], exceptions: {},
    completedTurnSerial: 0, seenTurnIds: [], nextEventId: 0, sourceRuleEpoch: 0, sourceRuleBaseline: {},
    trackingEpoch: 0, trackingBaseline: {}, revision: 0 });
  function scrubTaskCausesWithoutEvents(data) {
    const revisions=new Set((data.events||[]).map(event=>String(event?.revisionId||'' )).filter(Boolean));
    let changed=false;
    for(const task of Object.values(data.tasks||{})){
      if(task?.cause&&(!task.revisionId||!revisions.has(String(task.revisionId)))){delete task.cause;changed=true;}
    }
    return changed;
  }
  function captureTaskCauses(data){
    const causes=new Map();
    for(const [key,task] of Object.entries(data.tasks||{}))if(task&&Object.prototype.hasOwnProperty.call(task,'cause'))
      causes.set(key,{revisionId:task.revisionId,cause:clone(task.cause)});
    return causes;
  }
  function restoreTaskCauses(data,causes){
    for(const [key,prior] of causes){const task=data.tasks?.[key];if(task&&task.revisionId===prior.revisionId)task.cause=clone(prior.cause);}
  }
  function captureHistoryState(data){return {events:clone(data.events||[]),seenTurnIds:[...(data.seenTurnIds||[])],
    completedTurnSerial:Number(data.completedTurnSerial||0),causes:captureTaskCauses(data),revision:Number(data.revision||0)};}
  function restoreHistoryState(slot,state,{preserveNewEvents=false}={}){
    const current=slot.data.events||[];
    if(preserveNewEvents){
      const priorIds=new Set(state.events.map(event=>String(event.id)));
      slot.data.events=[...clone(state.events),...current.filter(event=>!priorIds.has(String(event.id)))];
    }else slot.data.events=clone(state.events);
    slot.data.seenTurnIds=[...state.seenTurnIds];slot.data.completedTurnSerial=state.completedTurnSerial;
    restoreTaskCauses(slot.data,state.causes);slot.data.revision=state.revision;
  }
  function decodeJournal(key, raw, { recover = false } = {}) {
    const data = raw == null || raw === '' ? empty(key) : (typeof raw === 'string' ? JSON.parse(raw) : clone(raw));
    if (data.schema !== SCHEMA || data.owner !== config.owner || data.scopeKey !== key || !data.tasks || typeof data.tasks !== 'object' || Array.isArray(data.tasks)) throw new Error('SOURCE_EDIT_JOURNAL_INVALID');
    if(!Array.isArray(data.events))data.events=[];
    if(!data.exceptions||typeof data.exceptions!=='object'||Array.isArray(data.exceptions))data.exceptions={};
    if(!Array.isArray(data.seenTurnIds))data.seenTurnIds=[];
    if(!Number.isSafeInteger(data.completedTurnSerial)||data.completedTurnSerial<0)data.completedTurnSerial=0;
    if(!Number.isSafeInteger(data.nextEventId)||data.nextEventId<0)data.nextEventId=0;
    if(!Number.isSafeInteger(data.sourceRuleEpoch)||data.sourceRuleEpoch<0)data.sourceRuleEpoch=0;
    if(!data.sourceRuleBaseline||typeof data.sourceRuleBaseline!=='object'||Array.isArray(data.sourceRuleBaseline))data.sourceRuleBaseline={};
    if(!Number.isSafeInteger(data.trackingEpoch)||data.trackingEpoch<0)data.trackingEpoch=0;
    if(!data.trackingBaseline||typeof data.trackingBaseline!=='object'||Array.isArray(data.trackingBaseline))data.trackingBaseline={};
    // Startup migration recovers a persisted in-flight task at the next request.
    // Explicit recovery reads must preserve durable states for comparison first.
    if(!recover)for (const task of Object.values(data.tasks)) if (['approved','running'].includes(task.state)) {
      task.state = 'interrupted'; task.error = '이전 실행이 중단되었습니다. 새 미리보기 후 직접 실행해 주세요.';
    }
    return data;
  }
  async function load(key) {
    if (!key) throw new Error('SOURCE_EDIT_SCOPE_REQUIRED');
    const slot = getScope(key);
    if (slot.data) return slot;
    if (!slot.load) slot.load = (async () => {
      const raw = await config.read(key);
      slot.data = decodeJournal(key, raw); slot.error = '';
      scrubTaskCausesWithoutEvents(slot.data);
      return slot;
    })().catch(error => { slot.error = String(error?.message || error); lastError = slot.error; throw error; }).finally(() => { slot.load = null; });
    return slot.load;
  }
  async function persist(slot) {
    const body = JSON.stringify({ ...slot.data, revision: ++slot.data.revision });
    const run = slot.save.catch(() => {}).then(async () => {
      if (disposed) throw new Error('SOURCE_EDIT_DISPOSED');
      const saved = await config.write(slot.key, body);
      if (saved === false) throw new Error('SOURCE_EDIT_JOURNAL_WRITE_REJECTED');
      const raw = await config.read(slot.key);
      const verified = typeof raw === 'string' ? raw : JSON.stringify(raw);
      if (verified !== body) throw new Error('SOURCE_EDIT_JOURNAL_READBACK_FAILED');
    });
    slot.save = run;
    try { await run; slot.error = ''; }
    catch (e) { slot.error = String(e?.message || e); lastError = slot.error; throw e; }
  }
  const recoveryCanonical=value=>Array.isArray(value)?value.map(recoveryCanonical):value&&typeof value==='object'
    ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,recoveryCanonical(value[key])])):value;
  const recoveryGuard = data => JSON.stringify(recoveryCanonical({
    tasks:data?.tasks||{}, exceptions:data?.exceptions||{},
    sourceRuleEpoch:Number(data?.sourceRuleEpoch||0), sourceRuleBaseline:data?.sourceRuleBaseline||{},
    trackingEpoch:Number(data?.trackingEpoch||0), trackingBaseline:data?.trackingBaseline||{}
  }));
  async function recoverScope(scopeKey) {
    const key=String(scopeKey||'');
    if(!key)return {ok:false,reason:'SOURCE_EDIT_SCOPE_REQUIRED'};
    const slot=getScope(key);
    if(!slot.error)return {ok:true,recovered:false,status:status(key)};
    // Only recover a previously validated journal. A read/schema error means
    // there is no trusted in-memory policy state to compare against.
    if(!slot.data)return {ok:false,reason:'SOURCE_EDIT_JOURNAL_UNVERIFIED',status:status(key)};
    const priorData=clone(slot.data),priorError=slot.error;
    try{
      const raw=await config.read(key),durable=decodeJournal(key,raw,{recover:true}),startup=decodeJournal(key,raw);
      if(recoveryGuard(priorData)!==recoveryGuard(durable)&&recoveryGuard(priorData)!==recoveryGuard(startup)){
        slot.error='SOURCE_EDIT_JOURNAL_RECOVERY_DIVERGED';lastError=slot.error;
        return {ok:false,reason:slot.error,status:status(key)};
      }
      // The durable copy wins for log/TTL-only changes that were not written.
      // Reinspect the current owner snapshot before clearing the fail-closed
      // write guard so a source edit that arrived meanwhile becomes a task.
      // Startup-only approved/running recovery is then committed before the
      // guard clears, avoiding a durable in-flight task that cannot be retried.
      slot.data=startup;slot.error='';
      if(recoveryGuard(startup)!==recoveryGuard(durable)){
        try{await persist(slot);}catch(error){slot.data=durable;throw error;}
      }
      const snapshot=await config.collect();
      if(snapshot?.scopeKey!==key||!Array.isArray(snapshot.units))throw new Error('SOURCE_EDIT_SCOPE_CHANGED');
      await inspect(snapshot,{phase:'explicit'});
      if(slot.error)throw new Error(slot.error);
      lastError='';safeNotify();
      return {ok:true,recovered:true,status:status(key)};
    }catch(error){
      slot.error=String(error?.message||error||priorError);lastError=slot.error;safeNotify();
      return {ok:false,reason:slot.error,status:status(key)};
    }
  }
  const cleanUnit = raw => ({
    key: String(raw.key || raw.start || ''), start: Number(raw.start || 0), end: Number(raw.end || raw.start || 0),
    digest: String(raw.digest || ''), sourceDigest: String(raw.sourceDigest || raw.digest || ''),
    rawDigest: String(raw.rawDigest || ''), originalRawDigest: String(raw.originalRawDigest || ''),
    ownerOriginalDigest: String(raw.originalDigest || ''), ownerOriginalRawDigest: String(raw.originalRawDigest || ''),
    policyUncertain: raw.policyUncertain === true,
    originalEvidenceUnavailable: raw.originalEvidenceUnavailable === true,
    identity: String(raw.identity || ''), basis: String(raw.basis || ''),
    changed: raw.changed === true, current: raw.current === true, conflict: String(raw.conflict || ''),
    originalDigest: String(raw.originalDigest || ''),
    changeKind: String(raw.changeKind || (raw.changed ? 'source_changed' : 'unchanged')),
    oldPacketHashes: Array.isArray(raw.oldPacketHashes) ? [...new Set(raw.oldPacketHashes.map(String))] : [],
    label: String(raw.label || `T${raw.start}${raw.end && raw.end !== raw.start ? '–T' + raw.end : ''}`)
  });
  async function inspect(snapshot, options = {}) {
    if (disposed || !snapshot?.scopeKey || !Array.isArray(snapshot.units)) return null;
    if(boundary)await loadPreferences();
    const key = String(snapshot.scopeKey); currentScope = key; lastError = '';
    // RAM cache is bounded; durable journals remain owner-owned and untouched.
    if (scopes.size > 4) for (const [oldKey, oldSlot] of scopes) {
      if (oldKey !== key && !oldSlot.load && ![...permits.keys()].some(k=>k.startsWith(oldKey+'\u0000')) && !reviewing) { scopes.delete(oldKey); if(scopes.size<=4)break; }
    }
    const slot = await load(key);
    if (disposed) return null;
    if(options.phase!=='explicit'){
      slot.units=new Map(snapshot.units.map(cleanUnit).filter(u=>u.key&&u.digest&&u.start>0).map(u=>[u.key,u]));
      slot.observedAt=now();return status();
    }
    let historyRollback=captureHistoryState(slot.data);
    let historyRollbackData=clone(slot.data);
    const persistHistoryChange=async()=>{
      try{await persist(slot);historyRollback=captureHistoryState(slot.data);historyRollbackData=clone(slot.data);}
      catch(error){
        restoreHistoryState(slot,historyRollback,{preserveNewEvents:true});
        // If inspection only changed housekeeping data, roll back the whole
        // journal snapshot. If it also found a new source/policy task, retain
        // that unpersisted guard so recovery remains fail-closed.
        if(recoveryGuard(slot.data)===recoveryGuard(historyRollbackData))slot.data=historyRollbackData;
        throw error;
      }
    };
    let units = snapshot.units.map(cleanUnit).filter(u => u.key && u.digest && u.start > 0);
    const policyEpoch=Number(preferences?.sourceRuleEpoch||0);
    const policyEpochChanged=slot.data.sourceRuleEpoch!==policyEpoch;
    const priorRuleBaseline=clone(slot.data.sourceRuleBaseline||{});
    let turnsChanged=false;
    if(Array.isArray(snapshot.completedTurnIds)){
      const seen=new Set(slot.data.seenTurnIds);
      for(const rawId of snapshot.completedTurnIds){const id=String(rawId||'');if(!id||seen.has(id))continue;
        seen.add(id);slot.data.seenTurnIds.push(id);slot.data.completedTurnSerial++;turnsChanged=true;}
      if(turnsChanged)slot.data.events=slot.data.events.filter(event=>slot.data.completedTurnSerial-Number(event.detectedTurnSerial||0)<10);
    }
    turnsChanged=scrubTaskCausesWithoutEvents(slot.data)||turnsChanged;
    // Read-only observations still refresh the ephemeral write guard. They do
    // not create journal entries or launch work, but stale applied permits are
    // immediately withheld when the owner reports a new source revision.
    if(boundary){slot.units=new Map(units.map(u=>[u.key,{...u,policyUncertain:false}]));slot.observedAt=now();}
    // Non-request callers only retain ephemeral write guards; they do not detect or journal edits.
    if(modeChanging){if(turnsChanged){await persistHistoryChange();safeNotify();}return status();}
    let policyRebased=false;
    if(policyEpochChanged){
      slot.data.sourceRuleEpoch=policyEpoch;
      policyRebased=true;
      units=units.map(unit=>{
        const old=slot.data.tasks[unit.key],baseline=priorRuleBaseline[unit.key];
        // A key can be reused after source topology changes. Only reuse a
        // journal baseline when its stable owner identity still names this
        // unit; owner-supplied original evidence is already independently
        // validated by that owner.
        const baselineMatches=!!(baseline?.identity&&unit.identity&&baseline.identity===unit.identity);
        const oldMatches=!!(old?.identity&&unit.identity&&old.identity===unit.identity);
        const rememberedDigest=unit.originalDigest||(baselineMatches?baseline.sourceDigest:'')||(oldMatches?old.sourceDigest:'');
        const dependencyProjectionChanged=unit.changed&&unit.changeKind==='dependency_affected';
        const projectionChanged=!!rememberedDigest&&rememberedDigest!==unit.sourceDigest||dependencyProjectionChanged;
        const uncertainPriorProjection=!rememberedDigest&&unit.policyUncertain;
        if(!projectionChanged&&!uncertainPriorProjection){
          const ignoredOnlyEdit=!!rememberedDigest&&rememberedDigest===unit.sourceDigest&&unit.changed&&unit.changeKind==='source_changed';
          return {...unit,policyUncertain:false,...(ignoredOnlyEdit?{changed:false,current:true,changeKind:'unchanged'}:{})};
        }
        const priorRaw=unit.originalRawDigest||(baselineMatches&&baseline.sourceDigest===rememberedDigest?baseline.rawDigest:'');
        const rawChanged=!!(priorRaw&&unit.rawDigest&&priorRaw!==unit.rawDigest);
        const policyUncertain=!priorRaw||!unit.rawDigest;
        // If the owner cannot reopen the old source-evidence bytes, an earlier
        // same-identity journal baseline still proves which projection it saw.
        // Carry that digest forward for branch protection, but keep the separate
        // evidence-unavailable flag so the UI never invents an old/new diff.
        const originalDigest=unit.originalDigest||(baselineMatches?baseline.sourceDigest:oldMatches?(old.originalDigest||old.sourceDigest):'');
        return {...unit,originalDigest,changed:true,current:false,forceRebuild:true,policyUncertain,
          changeKind:rawChanged?'source_and_policy_changed':'projection_policy_changed'};
      });
    }else units=units.map(unit=>({...unit,policyUncertain:false}));
    const nextRuleBaseline={...priorRuleBaseline};
    for(const unit of units){
      const next={sourceDigest:unit.sourceDigest,rawDigest:unit.rawDigest,identity:unit.identity,digest:unit.digest,basis:unit.basis};
      if(JSON.stringify(nextRuleBaseline[unit.key]||null)!==JSON.stringify(next))nextRuleBaseline[unit.key]=next;
    }
    if(JSON.stringify(nextRuleBaseline)!==JSON.stringify(slot.data.sourceRuleBaseline||{})){
      slot.data.sourceRuleBaseline=nextRuleBaseline;policyRebased=true;
    }
    slot.units = new Map(units.map(u => [u.key,u])); slot.observedAt = now();
    let changed = turnsChanged||policyRebased, newUpstream = false;
    const newTasks=[];
    for (const unit of units) {
      const old = slot.data.tasks[unit.key];
      if(options.onlyKeys&&!options.onlyKeys.includes(unit.key))continue;
      if (unit.changed) {
        if (!old || old.archived || old.digest !== unit.digest || old.sourceDigest !== unit.sourceDigest || old.identity !== unit.identity || old.basis !== unit.basis
            || String(old.ownerOriginalDigest||'')!==unit.ownerOriginalDigest || String(old.ownerOriginalRawDigest||'')!==unit.ownerOriginalRawDigest) {
          permits.delete(`${key}\u0000${unit.key}`);
          if(old?.revisionId){const previousEvent=slot.data.events.find(event=>event.revisionId===old.revisionId);if(previousEvent)previousEvent.state='superseded';}
          const revisionId=`${++slot.data.nextEventId}:${unit.key}`;
          const task={ ...unit, state: unit.conflict ? 'conflict' : 'awaiting_consent', detectedAt: now(), updatedAt: now(), attempts: 0, prompted: false,
            revisionId,
            cause:memorySuiteSourceEditCause(unit.changeKind,null),
            // Old carrier hashes remain blocked even after a replacement is adopted.
            oldPacketHashes: [...new Set([...(old?.oldPacketHashes || []), ...unit.oldPacketHashes])],
            error: unit.conflict || '', previousState: old?.state || '' };
          slot.data.tasks[unit.key]=task;newTasks.push(task);
          slot.data.events.push({id:revisionId,revisionId,key:unit.key,label:unit.label,start:unit.start,end:unit.end,
            sourceDigest:unit.sourceDigest,originalDigest:unit.originalDigest,changeKind:unit.changeKind,policyUncertain:unit.policyUncertain===true,
            originalEvidenceUnavailable:unit.originalEvidenceUnavailable===true,
            cause:clone(task.cause),detectedAt:now(),detectedTurnSerial:slot.data.completedTurnSerial,state:unit.conflict?'conflict':'detected'});
          changed = true;
        } else if (old.changeKind !== unit.changeKind
          && !(unit.changeKind==='source_changed'&&['source_and_policy_changed','projection_policy_changed'].includes(old.changeKind))) {
          // A metadata-only upgrade must neither reset a declined task nor
          // expand a permit. It distinguishes unchanged suffix dependencies.
          old.changeKind = unit.changeKind; changed = true;
        }
      } else if (unit.current && unit.changeKind==='response_variant' && old?.state!=='running') {
        const receipt={...unit,state:'superseded',resolvedBy:'response_variant',updatedAt:now(),prompted:false,attempts:0,error:''};
        if(!old||old.digest!==unit.digest||old.basis!==unit.basis||old.identity!==unit.identity||old.resolvedBy!=='response_variant'){
          permits.delete(key+'\u0000'+unit.key);slot.data.tasks[unit.key]=receipt;changed=true;
        }
      } else if (old && unit.current && old.state !== 'applied' && old.state !== 'running' && !old.forceRebuild) {
        // A source undo or externally verified owner commit needs no model call.
        permits.delete(`${key}\u0000${unit.key}`);
        Object.assign(old, { state: 'applied', updatedAt: now(), error: '', resolvedBy: 'owner_source_readback' }); changed = true;
      }
    }
    const reviewTasks=newTasks.filter(task=>task.changeKind!=='projection_policy_changed');
    if(reviewTasks.length){
      let reviewRows=new Map(),reviewFailure='';
      try{
        if(typeof config.loadReview!=='function')throw Error('SOURCE_REVIEW_UNAVAILABLE');
        const result=await config.loadReview(clone(reviewTasks),key);
        if(result?.scopeKey!==key||!Array.isArray(result.rows))throw Error('SOURCE_REVIEW_UNAVAILABLE');
        reviewRows=new Map(result.rows.map(row=>[String(row.key),row]));
      }catch(_){reviewFailure='review_unavailable';}
      for(const task of reviewTasks){
        const row=reviewRows.get(task.key),cause=memorySuiteSourceEditCause(task.changeKind,row,reviewFailure||'review_row_unavailable',config.owner);
        task.cause=cause;
        const event=slot.data.events.find(item=>item.revisionId===task.revisionId);
        if(event)event.cause=clone(cause);
      }
    }
    // Missing units are not analyzed with a recycled numeric turn index.
    for (const task of Object.values(slot.data.tasks)) {
      if (!slot.units.has(task.key) && !['applied','superseded'].includes(task.state)) {
        task.state = 'superseded'; task.error = '원문 위치가 변경되었거나 해당 구간이 미완성입니다.';
        permits.delete(`${key}\u0000${task.key}`); changed = true;
      }
    }
    if (changed) { await persistHistoryChange(); safeNotify(); }
    return status();
  }
  async function reconcileSelected(scopeKey, selectedKeys, proofCurrent) {
    const slot=scopes.get(scopeKey);
    if(!slot?.data||slot.error||disposed||config.enabled?.()===false||config.busy?.()===true)return;
    const excluded=Object.values(slot.data.tasks).filter(t=>slot.data.exceptions[t.revisionId]);
    const candidates=Object.values(slot.data.tasks).filter(t=>selectedKeys.has(t.key)&&!t.archived&&!t.conflict&&!slot.data.exceptions[t.revisionId]&&
      ['awaiting_consent','declined','failed','interrupted'].includes(t.state)).sort((a,b)=>a.start-b.start);
    for(const task of candidates){
      if(!proofCurrent()||disposed||currentScope!==scopeKey||mode()==='off'||config.enabled?.()===false||config.busy?.()===true)break;
      if(excluded.some(prefix=>task.start>prefix.end&&task.changeKind==='dependency_affected'))continue;
      const observed=slot.units.get(task.key);
      if(!observed||(!observed.changed&&!task.forceRebuild)||['digest','sourceDigest','basis','identity'].some(field=>observed[field]!==task[field]))continue;
      task.state='running';task.error='';task.updatedAt=now();task.attempts=Number(task.attempts||0)+1;
      try{await persist(slot);}catch(error){task.state='failed';task.error=String(error?.message||error);safeNotify();break;}
      const permit={digest:task.digest,sourceDigest:task.sourceDigest,basis:task.basis,identity:task.identity,issuedAt:now(),generation,requestGeneration};
      permits.set(`${scopeKey}\u0000${task.key}`,permit);safeNotify();
      const assertCurrent=async()=>{
        if(!proofCurrent()||disposed||config.enabled?.()===false)throw Error('SOURCE_EDIT_DISABLED');
        const snapshot=await config.collect();
        if(!proofCurrent()||disposed||config.enabled?.()===false)throw Error('SOURCE_EDIT_DISABLED');
        const live=snapshot?.units?.map(cleanUnit).find(unit=>unit.key===task.key);
        if(snapshot?.scopeKey!==scopeKey||!live||['digest','sourceDigest','basis','identity'].some(field=>live[field]!==task[field]))throw Error('SOURCE_EDIT_SOURCE_CHANGED');
        const priorChanged=['ownerOriginalDigest','ownerOriginalRawDigest'].some(field=>String(live[field]||'')!==String(task[field]||''));
        const ownReplacement=live.current===true&&live.originalDigest===task.sourceDigest
          &&(!live.originalRawDigest||live.originalRawDigest===live.rawDigest);
        if(priorChanged&&!ownReplacement)throw Error('SOURCE_EDIT_PRIOR_SOURCE_CHANGED');
        if(slot.data.tasks[task.key]!==task||!canWrite(scopeKey,task.key,task.sourceDigest))throw Error('SOURCE_EDIT_PERMIT_REVOKED');
        return snapshot;
      };
      try{
        await assertCurrent();
        const result=await config.execute(clone(task),{scopeKey,assertCurrent});
        if(result?.ok!==true)throw Error(result?.error||result?.reason||'SOURCE_EDIT_NOT_APPLIED');
        await assertCurrent();
        task.state='applied';task.forceRebuild=false;task.appliedAt=now();task.updatedAt=now();task.result=typeof config.receipt==='function'?config.receipt(result):{ok:true};
      }catch(error){
        if(slot.data.tasks[task.key]===task){task.state='failed';task.error=String(error?.message||error).slice(0,500);task.updatedAt=now();}
      }finally{
        permits.delete(`${scopeKey}\u0000${task.key}`);
        try{await persist(slot);}catch(error){slot.error=String(error?.message||error);lastError=slot.error;}
        safeNotify();
      }
      if(task.state!=='applied')break;
    }
  }
  const selectedBinding = (scopeKey, keys) => {
    const slot=scopes.get(scopeKey);
    if(!slot?.data||slot.error)return '';
    const rows=keys.map(key=>{
      const task=slot.data.tasks[key],unit=slot.units.get(key);
      if(!task||!unit||task.archived||task.conflict||slot.data.exceptions[task.revisionId]
        ||!['awaiting_consent','declined','failed','interrupted'].includes(task.state)
        ||(!unit.changed&&!task.forceRebuild)
        ||['digest','sourceDigest','basis','identity','ownerOriginalDigest','ownerOriginalRawDigest'].some(field=>String(unit[field]||'')!==String(task[field]||'')))return null;
      return [key,task.start,task.end,task.revisionId,task.digest,task.sourceDigest,task.basis,task.identity,task.ownerOriginalDigest||'',task.ownerOriginalRawDigest||''];
    });
    return rows.every(Boolean)?JSON.stringify([config.owner,scopeKey,generation,requestGeneration,
      preferences?.epoch,preferences?.sourceRuleEpoch,rows]):'';
  };
  async function previewSelected(input) {
    explicitPreview=null;
    const keys=Array.isArray(input)?[...new Set(input.map(String))]:[];
    if(!keys.length||keys.length>128)return {allowed:false,reason:'explicit_selection_required'};
    if(disposed||explicitWork||requestScope||config.busy?.()===true)return {allowed:false,reason:'owner_busy'};
    const startedGeneration=generation,startedRequest=requestGeneration;
    const observed=await refresh({phase:'explicit',onlyKeys:keys,prompt:false});
    if(disposed||!observed||observed.error||mode()==='off'||generation!==startedGeneration||requestGeneration!==startedRequest
      ||requestScope||config.busy?.()===true)return {allowed:false,reason:'owner_snapshot_unavailable'};
    const scopeKey=observed.scopeKey,binding=selectedBinding(scopeKey,keys);
    if(!binding)return {allowed:false,reason:'selected_source_unavailable'};
    const units=keys.map(key=>{const t=scopes.get(scopeKey).data.tasks[key];return Object.freeze({key,start:t.start,end:t.end,label:t.label||''});});
    const ticket=Object.freeze({schema:'memory-suite.explicit-source-reanalysis.v1',allowed:true,owner:config.owner,
      token:String(++previewSerial),scopeKey,units:Object.freeze(units),model:config.owner!=='flashback',
      warning:config.owner==='flashback'?'선택 원문으로 검색 자료를 갱신합니다. 요약 모델은 호출하지 않습니다.':'선택 구간을 기존 모델로 다시 분석합니다. 모델 사용량이 발생할 수 있습니다.'});
    explicitPreview={ticket,keys,binding,generation:startedGeneration,requestGeneration:startedRequest};
    return ticket;
  }
  const cancelSelected = () => { explicitPreview=null;generation+=1;permits.clear();safeNotify(); };
  async function applySelected(ticket) {
    const entry=explicitPreview;
    if(!entry||ticket!==entry.ticket)return {ok:false,reason:'stale_or_unknown_preview'};
    explicitPreview=null;
    if(disposed||explicitWork||requestScope||config.busy?.()===true)return {ok:false,reason:'owner_busy'};
    const proofCurrent=()=>!disposed&&generation===entry.generation&&requestGeneration===entry.requestGeneration&&mode()!=='off';
    const work=(async()=>{
      const observed=await refresh({phase:'explicit',onlyKeys:entry.keys,prompt:false});
      if(!proofCurrent()||!observed||observed.error||observed.scopeKey!==ticket.scopeKey||config.busy?.()===true
        ||selectedBinding(ticket.scopeKey,entry.keys)!==entry.binding)return {ok:false,reason:'selected_source_changed'};
      await reconcileSelected(ticket.scopeKey,new Set(entry.keys),proofCurrent);
      const tasks=entry.keys.map(key=>scopes.get(ticket.scopeKey)?.data?.tasks?.[key]);
      const ok=proofCurrent()&&tasks.every(task=>task?.state==='applied'&&task.result?.ok===true);
      return {ok,reason:ok?'selected_reanalysis_verified':'selected_reanalysis_incomplete',status:status(ticket.scopeKey)};
    })();
    explicitWork=work;
    try{return await work;}catch(error){return {ok:false,reason:String(error?.message||error)};}
    finally{if(explicitWork===work)explicitWork=null;}
  }
  function taskFor(key, unitKey) {
    const slot=scopes.get(String(key)),task=slot?.data?.tasks?.[String(unitKey)],unit=slot?.units.get(String(unitKey));
    if(boundary&&unit?.changed&&(!task||task.archived||['digest','sourceDigest','basis','identity'].some(field=>task[field]!==unit[field])))return {...unit,state:'awaiting_consent',protectionOnly:true};
    return task||null;
  }
  function canWrite(key, unitKey, digest) {
    if (disposed) return false;
    const slot = scopes.get(String(key));
    if (slot?.error) return false;
    const task = taskFor(key,unitKey);
    if(task?.revisionId&&slot?.data?.exceptions?.[task.revisionId])return false;
    if (!task || ['applied','superseded'].includes(task.state)) return true;
    const permit = permits.get(`${key}\u0000${unitKey}`);
    return !!permit && permit.generation===generation && permit.requestGeneration===requestGeneration && mode()!=='off' && !modeChanging
      && task.state === 'running' && permit.digest === task.digest
      && permit.sourceDigest === String(digest) && permit.basis === task.basis && permit.identity === task.identity
      && task.sourceDigest === String(digest) && currentScope === String(key);
  }
  function blocks(key, start, end = start) {
    const slot = scopes.get(String(key));
    if (slot?.error) return true;
    if(Object.values(slot?.data?.tasks||{}).some(t=>slot.data.exceptions?.[t.revisionId]&&t.start<=end&&t.end>=start))return true;
    if(boundary&&[...(slot?.units.values()||[])].some(u=>u.changed&&u.start<=end&&u.end>=start&&!canWrite(key,u.key,u.sourceDigest)))return true;
    return Object.values(slot?.data?.tasks || {}).some(t => !['applied','superseded'].includes(t.state) && t.start <= end && t.end >= start);
  }
  function rejectsPacket(key, turn, hash, sourceDigest = '') {
    const task = taskFor(key,turn);
    if (!task) return false;
    if(scopes.get(String(key))?.data?.exceptions?.[task.revisionId])return true;
    if (config.preserveUntilReplacement === true && (task.state !== 'applied' || task.result?.ok !== true)) return false;
    // Restoring the exact old visible text may legitimately restore its carrier.
    if (sourceDigest && task.originalDigest === String(sourceDigest)) return false;
    return (task.oldPacketHashes || []).includes(String(hash));
  }
  function status(scopeKey = '') {
    const key=String(scopeKey||currentScope),slot = scopes.get(key);
    const eventRevisions=new Set((slot?.data?.events||[]).map(event=>String(event.revisionId||'')));
    // A manual read may expose a newer revision without mutating the prior
    // task/event. Only explicit preview/apply can create its durable task.
    const viewUnits=[...(slot?.units.values()||[])].filter(unit=>{
      const prior=slot?.data?.tasks?.[unit.key];
      return unit.changed&&(!prior||prior.archived||['digest','sourceDigest','basis','identity','ownerOriginalDigest','ownerOriginalRawDigest']
        .some(field=>String(prior[field]||'')!==String(unit[field]||'')));
    });
    const viewKeys=new Set(viewUnits.map(unit=>unit.key));
    return { schema: SCHEMA, owner: config.owner, scopeKey:key, error: trackingError || slot?.error || lastError,
      mode:mode(),modeChanging,sourceRules:sourceRules(),explicitSourceRules:!!memorySuiteSourceRules(config.owner),ignoredTags:[...memorySuiteSourceTagPolicy(config.owner)],trackingEpoch:preferences?.epoch||0,sourceRuleEpoch:preferences?.sourceRuleEpoch||0,running: permits.size > 0, reviewing, lastReview: lastReview ? clone(lastReview) : null,
      events:(slot?.data?.events||[]).map(event=>{const task=slot?.data?.tasks?.[event.key];return {...clone(event),
        state:task?.revisionId===event.revisionId?task.state:event.state,
        excluded:!!slot?.data?.exceptions?.[event.revisionId]};}),
      tasks: [...Object.values(slot?.data?.tasks || {}).map(task=>viewKeys.has(task.key)?{...task,historicalView:true}:task),...viewUnits.map(unit=>({...unit,state:'awaiting_consent',protectionOnly:true}))].map(task=>{const projection={...clone(task), excluded:!!slot?.data?.exceptions?.[task.revisionId], stateLabel: task.resolvedBy==='response_variant' ? '응답 버전 전환' : config.preserveUntilReplacement===true && task.resolvedBy==='owner_source_readback' && task.result?.ok!==true ? '원문 동일 확인 · 재분석 없음' : ({
        awaiting_consent:'명시적 재분석 대기',conflict:'원문 식별 확인 필요',declined:'명시적 재분석 대기',approved:'처리 준비됨',running:'재처리 중',
        applied:'원문 반영됨',failed:'재처리 실패',interrupted:'다시 확인 필요',superseded:'대상 변경됨'
      })[task.state] || task.state };
        if(task.cause&&!eventRevisions.has(String(task.revisionId||'')))delete projection.cause;
        return projection;
      }) };
  }
  async function setException(scopeKey,unitKey,revisionId,enabled){
    const slot=await load(String(scopeKey)),task=slot.data.tasks[String(unitKey)];
    if(!task||!revisionId||task.revisionId!==revisionId)throw Error('SOURCE_EDIT_REVISION_CHANGED');
    if(enabled)slot.data.exceptions[revisionId]=true;
    else if(slot.data.exceptions[revisionId]){
      delete slot.data.exceptions[revisionId];
      task.state='awaiting_consent';task.forceRebuild=true;task.error='';task.updatedAt=now();
    }
    await persist(slot);safeNotify();return status();
  }
  async function deleteEvent(scopeKey,eventId){
    const slot=await load(String(scopeKey));
    const prior=clone(slot.data);
    const next=slot.data.events.filter(event=>event.id!==String(eventId));
    const changed=next.length!==slot.data.events.length;
    if(changed)slot.data.events=next;
    const scrubbed=scrubTaskCausesWithoutEvents(slot.data);
    if(changed||scrubbed){try{await persist(slot);}catch(error){slot.data=prior;throw error;}safeNotify();}
    return status();
  }
  async function recordCompletedTurn(scopeKey,logicalTurnId){
    if(!scopeKey||!logicalTurnId)return status();
    const slot=await load(String(scopeKey)),id=String(logicalTurnId);
    if(slot.data.seenTurnIds.includes(id))return status();
    const prior=clone(slot.data);
    slot.data.seenTurnIds.push(id);slot.data.completedTurnSerial++;
    slot.data.events=slot.data.events.filter(event=>slot.data.completedTurnSerial-Number(event.detectedTurnSerial||0)<10);
    scrubTaskCausesWithoutEvents(slot.data);
    try{await persist(slot);}catch(error){slot.data=prior;throw error;}safeNotify();return status();
  }
  async function refresh(options = {}) {
    if (disposed || config.enabled?.() === false) return null;
    if(boundary&&trackingError)return status();
    if(boundary){await loadPreferences();if(mode()==='off'||modeChanging)return status();}
    if (polling) return polling;
    polling = (async () => {
      const snap = await config.collect();
      if (!snap?.scopeKey) { currentScope=''; return null; }
      return inspect(snap, options);
    })().catch(error => { lastError = String(error?.message || error); safeNotify(); return null; }).finally(() => { polling = null; });
    return polling;
  }
  async function review(keys) { return previewSelected(keys); }
  function kick() { return; }
  function start() { return; }
  function dispose(){disposed=true;explicitPreview=null;permits.clear();dialogClose?.();}
  return Object.freeze({inspect,refresh,review,previewSelected,applySelected,cancelSelected,status,setMode,setIgnoredTags,setSourceRules,sourceRules,setException,deleteEvent,recordCompletedTurn,recoverScope,
    ready:async()=>{if(tagSave)await tagSave;return loadPreferences();},ignoredTags:()=>[...memorySuiteSourceTagPolicy(config.owner)],mountControls,beginRequest,beforeRequest,afterRequest,canWrite,blocks,rejectsPacket,taskFor,start,dispose,kick,loadScope:load,question:QUESTION});
}
