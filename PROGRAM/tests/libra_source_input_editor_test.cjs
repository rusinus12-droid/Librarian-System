'use strict';
const assert=require('node:assert/strict');
const {test}=require('node:test');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {JSDOM}=require('jsdom');
const code=fs.readFileSync(path.join(__dirname,'../sdk/MemorySuiteSourceInput.libra.source.js'),'utf8');
const plain=value=>JSON.parse(JSON.stringify(value));
const empty=()=>({version:1,ignoredTags:[],unwrapTags:[],sourceTags:[],controls:[]});
const tick=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
async function setup(options={}){
  const dom=new JSDOM('<!doctype html><main></main>');
  const context=vm.createContext({console:{log(){throw Error('sample logging forbidden');},warn(){throw Error('sample logging forbidden');},error(){throw Error('sample logging forbidden');}},setTimeout,clearTimeout});
  vm.runInContext(code,context);
  let stored=JSON.stringify(options.preferences??{}),writes=[],sampleCalls=0,legacyCalls=0,busy=false;
  const policy=context.createLibraSourceInputPolicy({
    read:async()=>stored,
    write:async body=>{writes.push(body);if(options.write)return options.write(body,value=>{stored=value;});stored=body;return true;},
    busy:()=>busy,
    readSample:async()=>{sampleCalls++;if(options.readSample)return options.readSample();return options.sample??{text:'  <unknown>Keep me</unknown>\r\nline  ' ,label:'현재 마지막 응답'};},
    projectLegacySample:async sample=>{legacyCalls++;return options.legacyText??sample.text.replace(/\r\n/g,'\n').trim();}
  });
  const root=dom.window.document.querySelector('main');policy.mountControls(root);await policy.ready();await tick();
  const find=selector=>root.querySelector(selector);
  const set=(node,value)=>{assert.ok(node,'required editor control exists');node.value=value;node.dispatchEvent(new dom.window.Event(node.tagName==='SELECT'?'change':'input',{bubbles:true}));};
  const row=()=>[...root.querySelectorAll('[data-source-input-row]')].at(-1);
  const add=(value,action='ignoredTags')=>{const item=row();set(item.querySelector('[data-rule-value]'),value);set(item.querySelector('[data-rule-action]'),action);return item;};
  const apply=async()=>{await find('[data-source-input-apply]').onclick();await tick();};
  const preview=async()=>{await find('[data-source-input-preview]').onclick();await tick();};
  return {context,root,policy,find,set,row,add,apply,preview,writes,get stored(){return JSON.parse(stored);},counts:()=>({sampleCalls,legacyCalls}),setBusy:value=>{busy=value;},close:()=>{policy.dispose();dom.window.close();}};
}

test('one analysis-input editor is usable without setup and does not read chat or persist at mount',async()=>{
 const f=await setup();try{
  assert.equal(f.root.querySelector('h3')?.textContent,'분석할 내용');
  assert.equal(f.root.querySelectorAll('[data-source-input-list]').length,1);
  assert.equal(f.root.querySelectorAll('.ms-rule-card').length,0);
  assert.equal([...f.root.querySelectorAll('button')].some(b=>/^(추가|수정 적용|규칙 저장)$/.test(b.textContent)),false);
  assert.match(f.root.textContent,/설정 없이/);assert.match(f.root.textContent,/알 수 없는/);
  assert.match(f.root.textContent,/기존 기억/);assert.match(f.root.textContent,/재분석/);
  assert.equal(f.writes.length,0);assert.equal(f.counts().sampleCalls,0);
  assert.equal(f.context.memorySuiteSourceRules('libra'),null);
 }finally{f.close();}
});

test('typed tag is saved with one Apply, unknown stored fields and old three-category rules survive',async()=>{
 const preferences={mode:'off',futureSetting:{keep:true},sourceRules:{...empty(),ignoredTags:['old-drop'],unwrapTags:['wrapper'],sourceTags:['original'],futureRule:{mode:'keep'}},externalRulesVersion:1};
 const f=await setup({preferences});try{
  f.add('decoration');await f.apply();assert.equal(f.writes.length,1);
  assert.deepEqual(f.stored.sourceRules.ignoredTags,['old-drop','decoration']);
  assert.deepEqual(f.stored.sourceRules.unwrapTags,['wrapper']);assert.deepEqual(f.stored.sourceRules.sourceTags,['original']);
  assert.deepEqual(f.stored.sourceRules.futureRule,{mode:'keep'});assert.deepEqual(f.stored.futureSetting,{keep:true});assert.equal(f.stored.mode,'off');
  assert.match(f.find('[data-source-input-status]').textContent,/적용했습니다/);
  await f.apply();assert.equal(f.writes.length,1,'unchanged Apply is not a second write');
 }finally{f.close();}
});

for(const [value,action,wanted]of [['story','unwrapTags','story'],['<ORIGINAL lang="ko">\ntext\n</ORIGINAL>','sourceTags','original'],['<decoration>','ignoredTags','decoration']])test('tag/example input infers normal closing tag: '+action,async()=>{
 const f=await setup({preferences:{sourceRules:empty(),externalRulesVersion:1}});try{
  f.add(value,action);await f.apply();assert.deepEqual(f.stored.sourceRules[action],[wanted]);
 }finally{f.close();}
});

test('custom delimiters are explicit and directly editable in the same list',async()=>{
 const f=await setup({preferences:{sourceRules:{...empty(),unwrapTags:[{open:'[OPEN]',close:'[CLOSE]'}]},externalRulesVersion:1}});try{
  const existing=f.root.querySelector('[data-source-input-row]');
  f.set(existing.querySelector('[data-rule-open]'),'[BEGIN]');f.set(existing.querySelector('[data-rule-close]'),'[END]');
  f.set(existing.querySelector('[data-rule-action]'),'sourceTags');await f.apply();
  assert.deepEqual(f.stored.sourceRules.sourceTags,[{open:'[BEGIN]',close:'[END]'}]);assert.deepEqual(f.stored.sourceRules.unwrapTags,[]);
  const fresh=f.row(),custom=fresh.querySelector('[data-rule-custom]');custom.checked=true;custom.dispatchEvent(new f.root.ownerDocument.defaultView.Event('change'));
  f.set(fresh.querySelector('[data-rule-open]'),'[SKIP]');f.set(fresh.querySelector('[data-rule-close]'),'[/SKIP]');await f.apply();
  assert.deepEqual(f.stored.sourceRules.ignoredTags,[{open:'[SKIP]',close:'[/SKIP]'}]);
 }finally{f.close();}
});

test('delete then Apply saves an explicit empty policy without reintroducing defaults',async()=>{
 const f=await setup({preferences:{sourceRules:{...empty(),ignoredTags:['drop'],controls:['html-comment']},externalRulesVersion:1}});try{
  for(const button of [...f.root.querySelectorAll('[data-rule-delete]')])if(!button.disabled)button.click();
  await f.apply();assert.deepEqual(f.stored.sourceRules,empty());
  await f.preview();assert.equal(f.find('[data-source-input-output]').textContent,'<unknown>Keep me</unknown>\nline');
  assert.equal(f.counts().legacyCalls,0);
 }finally{f.close();}
});

test('null legacy settings stay null through preview and use the actual legacy normalizer',async()=>{
 const f=await setup({preferences:{sourceRules:null,ignoredTags:[],future:5},legacyText:'actual legacy analysis input'});try{
  await f.preview();assert.equal(f.find('[data-source-input-output]').textContent,'actual legacy analysis input');
  assert.equal(f.stored.sourceRules,null);assert.equal(f.writes.length,0);assert.equal(f.counts().legacyCalls,1);
 }finally{f.close();}
});

test('local draft preview equals canonical analysis projection without saving sample text or rules',async()=>{
 const secret='LOCAL_SAMPLE_ONLY_83571';const sample=' \r\n<original><wrapper>Fact '+secret+'</wrapper><drop>remove</drop><unknown>keep</unknown></original>outside ';
 const f=await setup({preferences:{sourceRules:empty(),externalRulesVersion:1},sample:{text:sample,label:'최근 응답'}});try{
  f.add('original','sourceTags');f.add('wrapper','unwrapTags');f.add('drop','ignoredTags');await f.preview();
  const expected=f.context.memorySuiteProjectSourceRules(f.context.memorySuiteStripInternalSource(sample),{...empty(),sourceTags:['original'],unwrapTags:['wrapper'],ignoredTags:['drop']}).text.replace(/\r\n/g,'\n').trim();
  assert.equal(f.find('[data-source-input-output]').textContent,expected);assert.match(expected,/<unknown>keep<\/unknown>/);
  assert.equal(f.writes.length,0);assert.equal(JSON.stringify(f.stored).includes(secret),false);
  await f.apply();assert.equal(f.writes.some(body=>body.includes(secret)),false);
  assert.equal(f.root.querySelector('unknown'),null,'sample markup is rendered as plain text');
 }finally{f.close();}
});

for(const sample of ['before <original>broken <drop>keep</drop>','<original>one</original><original>two</original>','<original> </original><drop>keep</drop>'])test('invalid selection visibly warns and retains complete original sample: '+sample,async()=>{
 const f=await setup({preferences:{sourceRules:{...empty(),sourceTags:['original'],ignoredTags:['drop']},externalRulesVersion:1},sample});try{
  await f.preview();assert.equal(f.find('[data-source-input-output]').textContent,sample);
  assert.match(f.find('[data-source-input-warning]').textContent,/전체 본문/);assert.equal(f.find('[data-source-input-warning]').hidden,false);
 }finally{f.close();}
});

test('draft conflicts and malformed XML prevent Apply and show an actionable error',async()=>{
 const f=await setup({preferences:{sourceRules:empty(),externalRulesVersion:1}});try{
  const row=f.add('<open>text</wrong>');await f.apply();assert.equal(f.writes.length,0);assert.match(f.find('[data-source-input-status]').textContent,/태그|XML/);
  f.set(row.querySelector('[data-rule-value]'),'same');f.add('same','unwrapTags');await f.apply();assert.equal(f.writes.length,0);assert.match(f.find('[data-source-input-status]').textContent,/같은/);
 }finally{f.close();}
});

test('pending Apply cannot double-submit, disables edit controls, and reports success only after write verification',async()=>{
 let release;const gate=new Promise(resolve=>{release=resolve;});
 const f=await setup({preferences:{sourceRules:empty(),externalRulesVersion:1},write:async(body,store)=>{await gate;store(body);return true;}});try{
  f.add('skip');const first=f.find('[data-source-input-apply]').onclick();await tick();
  assert.equal(f.find('[data-source-input-apply]').disabled,true);assert.match(f.find('[data-source-input-status]').textContent,/적용 중/);
  assert.equal([...f.root.querySelectorAll('[data-source-input-list] input,[data-source-input-list] select')].every(n=>n.disabled),true);
  await f.find('[data-source-input-apply]').onclick();assert.equal(f.writes.length,1);release();await first;
  assert.match(f.find('[data-source-input-status]').textContent,/적용했습니다/);
 }finally{release();f.close();}
});

for(const failure of ['reject','readback'])test('save '+failure+' retains active settings and editable draft for retry',async()=>{
 let fail=true;
 const f=await setup({preferences:{sourceRules:empty(),externalRulesVersion:1},write:async(body,store)=>{if(fail)return failure==='reject'?false:true;store(body);return true;}});try{
  f.add('skip');await f.apply();assert.match(f.find('[data-source-input-status]').textContent,/실패/);
  assert.deepEqual(plain(f.policy.sourceRules()),empty());assert.equal(f.find('[data-rule-value]').value,'skip');
  assert.equal(f.find('[data-source-input-apply]').disabled,false);fail=false;await f.apply();assert.deepEqual(f.stored.sourceRules.ignoredTags,['skip']);
 }finally{f.close();}
});

test('preview read failure hides stale text, reports a useful state and never logs or stores the sample',async()=>{
 let fail=false;const f=await setup({readSample:async()=>{if(fail)throw Error('private data must not be echoed');return 'first sample';}});try{
  await f.preview();assert.equal(f.find('[data-source-input-output]').textContent,'first sample');fail=true;await f.preview();
  assert.equal(f.find('[data-source-input-output]').textContent,'');assert.match(f.find('[data-source-input-preview-status]').textContent,/읽지 못/);
  assert.equal(f.root.textContent.includes('private data must not be echoed'),false);assert.equal(f.writes.length,0);
 }finally{f.close();}
});

test('external migration preserves user rules and unknown fields while filtering only retired internal defaults',async()=>{
 const f=await setup({preferences:{ignoredTags:['mine','dag_runtime_contract'],sourceRules:{...empty(),ignoredTags:['mine','dag_runtime_contract','hayaku_packet_contract'],unwrapTags:['outside'],controls:['html-comment','suite-blocks'],unknown:{v:7}},externalRulesVersion:0,unknownTop:true}});try{
  assert.deepEqual(plain(f.policy.sourceRules().ignoredTags),['mine']);assert.deepEqual(plain(f.policy.sourceRules().unwrapTags),['outside']);assert.equal(f.writes.length,0);
  f.add('new');await f.apply();assert.deepEqual(f.stored.sourceRules.ignoredTags,['mine','new']);assert.deepEqual(f.stored.sourceRules.controls,['html-comment']);
  assert.deepEqual(f.stored.sourceRules.unknown,{v:7});assert.equal(f.stored.unknownTop,true);
 }finally{f.close();}
});

test('busy application leaves the draft and stored policy unchanged',async()=>{
 const f=await setup({preferences:{sourceRules:empty(),externalRulesVersion:1}});try{
  f.add('skip');f.setBusy(true);await f.apply();assert.equal(f.writes.length,0);assert.deepEqual(plain(f.policy.sourceRules()),empty());
  assert.match(f.find('[data-source-input-status]').textContent,/끝난 뒤|처리 중/);f.setBusy(false);await f.apply();assert.equal(f.writes.length,1);
 }finally{f.close();}
});

test('custom select-only rules require a closing delimiter and do not save partial input',async()=>{
 const f=await setup({preferences:{sourceRules:empty(),externalRulesVersion:1}});try{
  const row=f.row(),custom=row.querySelector('[data-rule-custom]');custom.checked=true;custom.dispatchEvent(new f.root.ownerDocument.defaultView.Event('change'));
  f.set(row.querySelector('[data-rule-open]'),'[START]');f.set(row.querySelector('[data-rule-action]'),'sourceTags');await f.apply();
  assert.equal(f.writes.length,0);assert.match(f.find('[data-source-input-status]').textContent,/닫는|단일/);
 }finally{f.close();}
});

test('mount is idempotent and preview output cannot insert sample HTML',async()=>{
 const sample='<img src=x onerror="alert(1)"><script>unsafe()</script>';
 const f=await setup({preferences:{sourceRules:empty(),externalRulesVersion:1},sample});try{
  f.policy.mountControls(f.root);assert.equal(f.root.querySelectorAll('[data-source-input-controls]').length,1);
  await f.preview();assert.equal(f.find('[data-source-input-output]').textContent,sample);assert.equal(f.root.querySelector('img,script'),null);
 }finally{f.close();}
});

test('changing rules while the chat sample is loading previews the latest draft after the read',async()=>{
 let release;const gate=new Promise(resolve=>{release=resolve;});
 const f=await setup({preferences:{sourceRules:empty(),externalRulesVersion:1},readSample:async()=>{await gate;return 'left<skip>remove</skip>right';}});try{
  const preview=f.find('[data-source-input-preview]').onclick();await tick();f.add('skip');release();await preview;await tick();
  assert.equal(f.find('[data-source-input-output]').textContent,'leftright');assert.match(f.find('[data-source-input-preview-status]').textContent,/아직 적용하지 않은/);
 }finally{release();f.close();}
});

test('switching a standard tag to explicit delimiters retains its rule rather than silently deleting it',async()=>{
 const f=await setup({preferences:{sourceRules:{...empty(),unwrapTags:['wrapper']},externalRulesVersion:1}});try{
  const row=f.root.querySelector('[data-source-input-row]'),custom=row.querySelector('[data-rule-custom]');
  custom.checked=true;custom.dispatchEvent(new f.root.ownerDocument.defaultView.Event('change'));
  assert.equal(row.querySelector('[data-rule-open]').value,'<wrapper>');assert.equal(row.querySelector('[data-rule-close]').value,'</wrapper>');
  await f.apply();assert.equal(f.writes.length,0,'equivalent editing mode does not change the stored policy');
 }finally{f.close();}
});

test('switching a custom delimiter to tag input cannot silently delete the stored rule',async()=>{
 const f=await setup({preferences:{sourceRules:{...empty(),ignoredTags:[{open:'[OPEN]',close:'[CLOSE]'}]},externalRulesVersion:1}});try{
  const row=f.root.querySelector('[data-source-input-row]'),custom=row.querySelector('[data-rule-custom]');
  custom.checked=false;custom.dispatchEvent(new f.root.ownerDocument.defaultView.Event('change'));
  await f.apply();assert.equal(f.writes.length,0);assert.match(f.find('[data-source-input-status]').textContent,/직접 구분자/);
  assert.equal(row.querySelector('[data-rule-value]').value,'[OPEN]');
 }finally{f.close();}
});
