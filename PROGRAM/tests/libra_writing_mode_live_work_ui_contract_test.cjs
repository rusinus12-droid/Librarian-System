'use strict';
// Retired: Writer modals, RP/Novel engines and family selector. Retained: exact
// tab count/accessibility and live memory-work progress with generation fences.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createLibraVmHarness,expose}=require('./fixtures/libra_retained_contract_probe.cjs');
const source=fs.readFileSync(path.join(__dirname,'../plugins/LIBRA.js'),'utf8');
assert.match(source,/sga-prompt-injection-tabs\.libra-hub-tabs\.cols-4\{grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
const start=source.indexOf('const buildLibraHubTabs ='),end=source.indexOf('const buildLibraSectionRail =',start);assert(start>=0&&end>start);
const clicks=[],c=vm.createContext({guiEl:(tag,attrs={},children=[])=>({tag,attrs,children}),syncGuiTabSelectionFeedback:()=>clicks.push('feedback'),queueGuiNavigationRender:()=>clicks.push('render')});
vm.runInContext(source.slice(start,end)+'\nthis.tabs=buildLibraHubTabs;',c);
const defs=['one','two','three','four'].map(id=>({id,label:id})),tabs=c.tabs(defs,'one',id=>clicks.push(id),'memory stages'),nav=tabs.children[0];
assert.equal(nav.attrs.role,'tablist');assert.equal(nav.attrs['aria-label'],'memory stages');assert.match(nav.attrs.class,/cols-4/);assert.equal(nav.children.length,4);
nav.children.forEach((n,i)=>{assert.equal(n.attrs.role,'tab');assert.equal(n.attrs['aria-selected'],String(i===0));assert.equal(n.attrs.tabIndex,i===0?0:-1);});
nav.children[0].attrs.onClick({currentTarget:nav.children[0]});assert.deepEqual(clicks,[]);
nav.children[1].attrs.onClick({currentTarget:nav.children[1]});assert.deepEqual(clicks,['two','feedback','render']);
(async()=>{
 const panels=[],h=await createLibraVmHarness({enable_gui:'false'},{async setChatPanel(...args){panels.push(args);return true;}},{transformSource:expose});
 try{
  const p=h.context.__retainedOuter();
  const first=await p.updatePipelineWorkPanel('memory start','preparing',{begin:true,scopeKey:'scope',stagePlan:['librarian']});
  assert.equal(h.api.getPipelineWorkStatus().busy,true);assert.equal(await p.reportPipelineStageProgress('librarian','analysis',first),true);assert.equal(h.api.getPipelineWorkStatus().currentStage,'librarian');
  assert.equal(await p.finishPipelineWorkStatus('memory complete',true,0,'completed',first),true);let status=h.api.getPipelineWorkStatus();assert.equal(status.busy,false);assert.equal(status.resultAvailable,true);assert.equal(status.ok,true);assert(Array.from(status.completedStages).includes('librarian'));
  const next=await p.updatePipelineWorkPanel('new memory','preparing',{begin:true,stagePlan:['librarian']});assert(next>first);
  assert.equal(await p.reportPipelineStageProgress('librarian','analysis',first),false);assert.equal(await p.finishPipelineWorkStatus('old failure',false,0,'failed',first),false);assert.equal(h.api.getPipelineWorkStatus().message,'new memory');
  assert.equal(await p.finishPipelineWorkStatus('current failure',false,0,'failed',next),true);status=h.api.getPipelineWorkStatus();assert.equal(status.busy,false);assert.equal(status.ok,false);assert.equal(status.phase,'failed');assert(panels.length>0);
 }finally{await h.cleanup();}
 console.log('libra_writing_mode_live_work_ui_contract_test: PASS (retained tabs and live memory work; writing engines retired)');
})().catch(e=>{console.error(e);process.exitCode=1;});
