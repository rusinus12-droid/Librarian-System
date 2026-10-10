'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {test}=require('node:test');

class Element{
  constructor(tag,doc){this.tagName=tag.toLowerCase();this.ownerDocument=doc;this.children=[];this.attributes=new Map();this.dataset={};this.style={};this.value='';this.textContent='';this.disabled=false;this.isConnected=true;}
  append(...nodes){for(const node of nodes){node.parent=this;this.children.push(node);}}
  prepend(...nodes){for(const node of nodes){node.parent=this;this.children.unshift(node);}}
  insertBefore(node,reference){const index=this.children.indexOf(reference);node.parent=this;this.children.splice(index<0?this.children.length:index,0,node);}
  replaceChildren(...nodes){this.children=[];this.append(...nodes);}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(node=>node!==this);this.isConnected=false;}
  setAttribute(key,value){this.attributes.set(key,String(value));}
  getAttribute(key){return this.attributes.get(key)||null;}
  querySelector(selector){if(selector==='[data-source-tracking-controls]')return this.walk().find(node=>node.dataset.sourceTrackingControls)||null;return null;}
  querySelectorAll(selector){const names=selector.split(',').map(name=>name.trim());return this.walk().filter(node=>names.includes(node.tagName));}
  walk(){return this.children.flatMap(child=>[child,...child.walk()]);}
  focus(){}
}
function setup(options={}){
  const doc={createElement(tag){return new Element(tag,doc);}};
  const root=new Element('div',doc),storage=new Map();
  let changed=true,comparisons=0,prompts=0;
  const sourceUnit={...(options.unit||{})};
  const context=vm.createContext({setTimeout,clearTimeout,Date,console});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../sdk/MemorySuiteSourceEditConsent.source.js'),'utf8'),context);
  const makeController=()=>context.createMemorySuiteSourceEditConsent({owner:'libra',requestBoundary:true,
    read:async key=>storage.get(key)??null,write:async(key,value)=>{storage.set(key,value);return true;},
    collect:async()=>({scopeKey:'chat',units:[{key:'1',start:1,end:1,digest:'new',sourceDigest:'new',originalDigest:'old',basis:'b',identity:'i',...sourceUnit,changed,current:!changed}]}),
    loadReview:async(_tasks,scopeKey)=>{comparisons++;return{rows:options.reviewRows||[],scopeKey};},
    prompt:async()=>{prompts++;return{decision:'approve',keys:['1']};},
    execute:options.execute|| (async(task,permit)=>{await permit.assertCurrent();changed=false;return{ok:true};})
  });
  const controller=makeController();
  return {root,controller,context,storage,makeController,setUnit:value=>Object.assign(sourceUnit,value),get comparisons(){return comparisons;},get prompts(){return prompts;}};
}
const find=(root,tag,label)=>root.walk().find(node=>node.tagName===tag&&(node.getAttribute('aria-label')===label||node.textContent===label));

test('explicit source controls omit detection mode and edit delimiters',async()=>{
  const f=setup();try{
    f.controller.mountControls(f.root);await f.controller.ready();await Promise.resolve();
    const select=f.root.walk().find(node=>node.tagName==='select');
    assert.equal(select,undefined);
    const open=find(f.root,'input','원문이 들어 있는 태그 여는 표식');
    const close=find(f.root,'input','원문이 들어 있는 태그 닫는 표식');
    open.value='<original>';close.value='</original>';
    const sourceCard=f.root.walk().find(node=>node.dataset.sourceRule==='sourceTags');
    sourceCard.walk().find(node=>node.tagName==='button'&&node.textContent==='추가').onclick();
    await find(f.root,'button','규칙 저장').onclick();
    const edit=find(f.root,'button','<original> → </original> 수정');
    assert.ok(edit,'saved delimiter should have a direct edit action');
    edit.onclick();assert.equal(open.value,'<original>');assert.equal(close.value,'</original>');
    open.value='[original]';close.value='[/original]';
    sourceCard.walk().find(node=>node.tagName==='button'&&node.textContent==='수정 적용').onclick();
    await find(f.root,'button','규칙 저장').onclick();
    assert.equal(f.controller.sourceRules().sourceTags[0].open,'[original]');
    assert.equal(f.controller.sourceRules().sourceTags[0].close,'[/original]');
  }finally{f.controller.dispose();}
});

test('retired mode compatibility never shows a consent popup',async()=>{
  const f=setup();try{
    f.controller.mountControls(f.root);await f.controller.ready();await Promise.resolve();
    const select=f.root.walk().find(node=>node.tagName==='select');
    assert.equal(select,undefined);
    await f.controller.beforeRequest();
    const review=await f.controller.review();
    assert.equal(review.reason,'explicit_selection_required');
    assert.equal(f.prompts,0);
    assert.equal(f.root.walk().some(node=>/확인하기|동의|승인/.test(node.textContent)),false);
    await f.controller.setMode('off');
    assert.equal(f.controller.status().mode,'explicit_only');
    await f.controller.beforeRequest();
    assert.equal(f.prompts,0);
    assert.equal(f.root.walk().some(node=>/확인하기|동의|승인/.test(node.textContent)),false);
  }finally{f.controller.dispose();}
});

test('owner bundles retain no invocation path to the obsolete source review popup',()=>{
  const files=['../sdk/MemorySuiteSourceReview.source.js','../plugins/LIBRA.js','../plugins/HAYAKU_Locator_Continuity.js','../plugins/Flashback_Memory.js'];
  for(const relative of files){
    const source=fs.readFileSync(path.join(__dirname,relative),'utf8');
    const references=[...source.matchAll(/\bshowMemorySuiteSourceReview\s*\(/g)].length;
    assert.equal(references,0,`${relative} must not ship the obsolete popup or any invocation path`);
    assert.equal(source.includes('원문 수정을 대기 중입니다 · 확인하기'),false,`${relative} must not ship the obsolete pending-consent dock`);
  }
});

test('recent edit controls exclude a revision and delete only its visible event',async()=>{
  const f=setup();try{
    await f.controller.previewSelected(['1']);f.controller.mountControls(f.root);await f.controller.ready();await Promise.resolve();
    const exclude=find(f.root,'button','예외 지정');assert.ok(exclude);
    await exclude.onclick();assert.equal(f.controller.status().tasks[0].excluded,true);
    const remove=find(f.root,'button','내역 삭제');assert.ok(remove);
    await remove.onclick();assert.equal(f.controller.status().events.length,0);
    assert.equal(f.controller.status().tasks[0].excluded,true);
  }finally{f.controller.dispose();}
});

test('source rule descriptions match their comparison behavior for editable custom wrappers',async()=>{
  const f=setup();try{
    f.controller.mountControls(f.root);await f.controller.ready();await Promise.resolve();
    const card=key=>f.root.walk().find(node=>node.dataset.sourceRule===key);
    const description=key=>card(key).children.find(node=>node.tagName==='p')?.textContent;
    assert.equal(description('sourceTags'),'GigaTrans 사용자를 위한 고급 기능입니다. 원문이 들어있는 태그를 지정하면 이 태그 바깥의 변경(번역문)은 무시합니다.');
    assert.equal(description('unwrapTags'),'태그 안에 실제 본문이 들어있는 경우 사용합니다. 원문이 들어있는 태그와의 차이는 태그 밖의 내용을 무시하지 않는다는 점입니다. 본문 내용을 특정 태그로 감싸는 경우 사용하세요.');
    assert.equal(description('ignoredTags'),'일반적인 태그 제거 기능입니다. 특정 모듈, 플러그인이 사용하는 태그를 지정하면 해당 태그를 무시합니다.');

    const rules=f.context.memorySuiteNormalizeSourceRules({version:1,sourceTags:[{open:'[SOURCE START]',close:'[SOURCE END]'}],
      unwrapTags:[{open:'<box>',close:'</box>'}],ignoredTags:[{open:'[PLUGIN START]',close:'[PLUGIN END]'}],controls:[]});
    const project=value=>f.context.memorySuiteProjectSourceRules(value,rules).text;
    assert.equal(project('[SOURCE START]The fact.[SOURCE END] translation one'),'The fact.');
    assert.equal(project('[SOURCE START]The fact.[SOURCE END] translation two'),'The fact.');

    const unwrapRules=f.context.memorySuiteNormalizeSourceRules({version:1,sourceTags:[],unwrapTags:[{open:'[OPEN]',close:'[CLOSE]'}],ignoredTags:[],controls:[]});
    assert.equal(f.context.memorySuiteProjectSourceRules('left [OPEN]body[CLOSE] right',unwrapRules).text,'left body right');
    const ignoreRules=f.context.memorySuiteNormalizeSourceRules({version:1,sourceTags:[],unwrapTags:[],ignoredTags:[{open:'[PLUGIN START]',close:'[PLUGIN END]'}],controls:[]});
    assert.equal(f.context.memorySuiteProjectSourceRules('left [PLUGIN START]generated[CLOSE?][PLUGIN END] right',ignoreRules).text,'left  right');
  }finally{f.controller.dispose();}
});

test('policy reanalysis is shown as rule work without an invented source comparison',async()=>{
  const f=setup();
  try{
    await f.controller.setSourceRules({version:1,sourceTags:[{open:'<original>',close:'</original>'}],ignoredTags:[],unwrapTags:[],controls:[]});
    await f.controller.previewSelected(['1']);
    f.controller.mountControls(f.root);await f.controller.ready();await Promise.resolve();
    assert.ok(f.root.walk().some(node=>node.textContent.includes('표식 규칙 변경으로 재분석')));
    assert.equal(f.comparisons,0);
    assert.equal(f.root.walk().some(node=>node.textContent==='원문 비교'),false);
  }finally{f.controller.dispose();}
});

test('recent history renders labels safely and omits fabricated comparison when prior raw is unavailable',async()=>{
  const hostileLabel='<img src=x onerror="alert(1)">';
  const f=setup({unit:{label:hostileLabel,originalRawDigest:'',policyUncertain:true,originalEvidenceUnavailable:true}});
  try{
    await f.controller.setSourceRules({version:1,sourceTags:[{open:'<original>',close:'</original>'}],ignoredTags:[],unwrapTags:[],controls:[]});
    await f.controller.previewSelected(['1']);
    assert.equal(f.controller.status().tasks[0].policyUncertain,true);
    assert.equal('beforeText' in f.controller.status().events[0],false);
    f.controller.mountControls(f.root);await f.controller.ready();await Promise.resolve();
    assert.equal(f.root.walk().some(node=>node.tagName==='img'),false,'owner-provided markup stays a text label');
    const heading=f.root.walk().find(node=>node.tagName==='strong'&&node.textContent.includes(hostileLabel));
    assert.ok(heading);assert.equal(heading.textContent,hostileLabel+' · 표식 규칙 변경으로 재분석 · 명시적 재분석 대기');
    const note=f.root.walk().find(node=>node.tagName==='p'&&node.textContent.includes('이전 원문 비교 자료가 없어'));
    assert.ok(note,'the UI explains why it cannot show a before/after comparison');
    assert.equal(f.root.walk().some(node=>node.tagName==='button'&&node.textContent==='원문 비교'),false);
    assert.equal(f.comparisons,0);
  }finally{f.controller.dispose();}
});

test('recent history reports an explicitly requested processing failure',async()=>{
  const f=setup({execute:async()=>{throw Error('provider_unavailable');}});
  try{
    await f.controller.previewSelected(['1']);f.controller.afterRequest();
    assert.equal(f.controller.status().tasks[0].state,'awaiting_consent','detection did not call failing provider');
    const ticket=await f.controller.previewSelected(['1']);await f.controller.applySelected(ticket);
    assert.equal(f.controller.status().tasks[0].state,'failed');
    f.controller.mountControls(f.root);await f.controller.ready();await Promise.resolve();
    const heading=f.root.walk().find(node=>node.tagName==='strong'&&node.textContent.includes('재처리 실패'));
    const detail=f.root.walk().find(node=>node.tagName==='p'&&node.textContent==='provider_unavailable');
    assert.ok(heading);assert.ok(detail);
    assert.equal(f.root.walk().some(node=>node.textContent.includes('승인')),false);
  }finally{f.controller.dispose();}
});

test('a tag cause can be excluded from history, saved to owner settings, and read by a fresh controller',async()=>{
  const f=setup({reviewRows:[{key:'1',currentValid:true,previousUnavailable:false,
    beforeText:'<draft>Alice signed.</draft>',afterText:'<draft>Alice did not sign.</draft>'}]});
  try{
    await f.controller.previewSelected(['1']);
    f.controller.afterRequest();
    f.controller.mountControls(f.root);await f.controller.ready();await Promise.resolve();
    const ignore=find(f.root,'button','비교 제외 규칙에 추가');
    assert.ok(ignore,'the detected exact wrapper should offer a direct ignoredTags action');
    const cause=f.root.walk().find(node=>node.tagName==='p'&&node.textContent.includes('검증된 예외 규칙 후보'));
    assert.ok(cause?.textContent.includes('원문 내용 변경')&&cause.textContent.includes('비교 제외')&&cause.textContent.includes('<draft>')&&cause.textContent.includes('</draft>'),
      'the cause log must show a Korean cause class and the exact wrapper before the user acts');
    assert.equal(cause.textContent.includes('ignoredTags'),false,'stored taxonomy identifiers are not user-facing copy');
    assert.equal(cause.textContent.includes('source_projection:'),false,'stored rule identifiers are not user-facing copy');
    await ignore.onclick();
    const saved=JSON.parse(f.storage.get('__source_tracking_preferences_v1__'));
    assert.equal(saved.sourceRuleEpoch,1);
    assert.ok(saved.sourceRules.ignoredTags.includes('draft'),'the standard HTML wrapper is stored in the canonical tag-name form');
    assert.equal(find(f.root,'p','태그 규칙을 저장하고 읽어 확인했습니다. 다음 명시적 원문 조회·재분석에 저장한 규칙을 적용합니다.')?.textContent,
      '태그 규칙을 저장하고 읽어 확인했습니다. 다음 명시적 원문 조회·재분석에 저장한 규칙을 적용합니다.');

    f.controller.dispose();
    f.context.memorySuiteSourceRules.policies.delete('libra');
    f.context.memorySuiteSourceTagPolicy.policies.delete('libra');
    const reloaded=f.makeController();
    try{
      await reloaded.ready();
      assert.ok(reloaded.sourceRules().ignoredTags.includes('draft'),'the fresh controller must read back the semantically equivalent canonical rule');
    }finally{reloaded.dispose();}
  }finally{if(f.controller.status)f.controller.dispose();}
});
