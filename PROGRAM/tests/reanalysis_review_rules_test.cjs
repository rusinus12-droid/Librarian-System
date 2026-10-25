'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {JSDOM}=require('jsdom');
const code=['MemorySuiteSourceInput.libra.source.js','MemorySuiteSourceInputControls.source.js'].map(file=>fs.readFileSync(path.join(__dirname,'../sdk',file),'utf8')).join('\n');
const plain=value=>JSON.parse(JSON.stringify(value));
function extraction(){const ctx=vm.createContext({});vm.runInContext(code,ctx);return (body,selected)=>{const start=body.indexOf(selected);return plain(ctx.memorySuiteExtractSelectedSourceTags(body,start,start+selected.length));};}
test('selection extracts a containing XML pair, complete nested tags, literal delimiters and comments',()=>{
  const extract=extraction();
  assert.deepEqual(extract('<box><drop a=">">private</drop></box>','private'),['drop']);
  assert.deepEqual(extract('<box><a>A</a><b>B</b></box>','<a>A</a><b>B</b>'),['a','b']);
  assert.deepEqual(extract('[PLUGIN START]private[PLUGIN END]','private'),[{open:'[PLUGIN START]',close:'[PLUGIN END]'}]);
  assert.deepEqual(extract('<!--private-->','private'),[{open:'<!--',close:'-->'}]);
});
test('unbalanced tags, plain prose, empty selections and Suite protocol tags never become exclusion rules',()=>{
  const extract=extraction();assert.deepEqual(extract('<drop>private','private'),[]);
  assert.deepEqual(extract('ordinary prose','prose'),[]);assert.deepEqual(extract('<a>A</a>',''),[]);
  assert.deepEqual(extract('<hayaku_packet_contract>private</hayaku_packet_contract>','private'),[]);
});
async function setup(){
  const dom=new JSDOM('<main></main>'),ctx=vm.createContext({});vm.runInContext(code,ctx);
  let stored='',writes=0,runs=0;const policy=ctx.createMemorySuiteSourceInputPolicy({owner:'flashback',read:async()=>stored,write:async value=>{stored=value;writes++;return true;}});
  await policy.ready();const root=dom.window.document.querySelector('main');
  ctx.mountMemorySuiteReanalysisReview(root,{owner:'flashback',policy,sample:{label:'T1',user:'Question',assistant:'<drop>private</drop> Kept narrative'},current:()=>true,validate:async()=>true,
    projectLegacySample:sample=>sample.text,onRun:async guard=>{await guard();runs++;}});
  for(let i=0;i<8;i++)await Promise.resolve();
  return {root,ctx,policy,dom,get writes(){return writes;},get runs(){return runs;},close:()=>{policy.dispose();dom.window.close();}};
}
test('saved built-in controls are editable, and an empty analysis cannot be submitted',async()=>{
  const f=await setup();try{
    const rows=[...f.root.querySelectorAll('[data-review-rule]')];assert.ok(rows.some(row=>row.querySelector('input').value==='<!--'));
    rows.find(row=>row.querySelector('input').value==='<!--').querySelector('button').click();
    const source=f.root.querySelector('[data-review-source="assistant"]');source.setSelectionRange(6,13);source.onselect();f.root.querySelector('[data-review-extract]').click();
    const drop=[...f.root.querySelectorAll('[data-review-rule]')].find(row=>row.querySelector('input').value==='<drop>');
    drop.querySelector('input').value='';drop.querySelectorAll('input')[1].value='';
    // A literal single marker matching the entire response removes all analysis content.
    drop.querySelector('input').value=source.value;
    await f.root.querySelector('[data-review-apply]').onclick();
    assert.equal(f.root.querySelector('[data-review-run]').disabled,true);assert.match(f.root.querySelector('[data-review-status]').textContent,/비어 있습니다/);
    assert.equal(f.writes,0);assert.equal(f.runs,0);
  }finally{f.close();}
});
test('editing tags invalidates Apply and external policy changes cannot be overwritten by an old draft',async()=>{
  const f=await setup();try{
    const apply=f.root.querySelector('[data-review-apply]'),run=f.root.querySelector('[data-review-run]');
    await apply.onclick();assert.equal(run.disabled,false);
    const row=f.root.querySelector('[data-review-rule] input');row.value='<edited>';row.oninput();assert.equal(run.disabled,true);
    await f.policy.setSourceRules({version:1,ignoredTags:['external'],unwrapTags:[],sourceTags:[],controls:[]});
    await apply.onclick();assert.equal(run.disabled,true);assert.match(f.root.querySelector('[data-review-status]').textContent,/검토를 다시 열어/);
    assert.deepEqual(plain(f.policy.sourceRules().ignoredTags),['external']);assert.equal(f.writes,1);
  }finally{f.close();}
});
