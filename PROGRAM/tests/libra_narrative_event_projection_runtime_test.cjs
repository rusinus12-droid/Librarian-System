'use strict';
// Drives the production story-page builder (buildApprovedMockupStory over bookNarrativeModel) with DOM
// substitutes. The former buildBookNarrativeTocProjection was replaced by this almanac page: the
// '사건 연대기' (chron) tab lists events, '남은 이야기' (open) lists threads, and an empty narrative
// shows the explicit empty state.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(process.env.LIBRA_TEST_PLUGIN||path.join(__dirname,'../plugins/LIBRA.js'),'utf8');
const slice=(a,b)=>{const start=source.indexOf(a),end=source.indexOf(b,start);assert.ok(start>=0&&end>start,`source anchors not found: ${a} .. ${b}`);return source.slice(start,end);};
const modelSource=slice('const BOOK_NARRATIVE_GROUPS =','const buildBookHostLineagePanel =');
const storySource=slice('const buildApprovedMockupStory = () => {','const buildApprovedMockupDestinationDetail =');
let narrative={events:[{id:'e',turn:5,text:'도서관 문이 열렸다.'}]};
const el=(tag,attrs={},children=[])=>({tag,...attrs,children:(Array.isArray(children)?children:[children]).filter(Boolean)});
const ctx=vm.createContext({LibraMemoryCore:{peekSnapshot:()=>({})},canonicalReaderBinding:()=>({scopeKey:'test'}),
  Gui:{approvedStoryTab:'chron',narrativeDirectionLoading:true},
  worldManagerSnapshotView:()=>({narrative,throughTurn:5}),guiAsObject:v=>v&&typeof v==='object'&&!Array.isArray(v)?v:{},guiAsArray:v=>Array.isArray(v)?v:[],
  text:v=>String(v??''),compact:(value,max)=>String(value??'').slice(0,max),narrativeDirectionScopeKey:()=>'',
  loadNarrativeDirectionDraft:async()=>{},saveNarrativeDirectionDraft:async()=>{},clearNarrativeDirectionDraft:async()=>{},
  queueGuiNavigationRender:()=>{},bookSelectStorySection:()=>{},bookNavigate:()=>{},guiEl:el,JSON,Promise,Number,String,Math,Set,Map,Object});
vm.runInContext(modelSource+'\n'+storySource+';globalThis.build=buildApprovedMockupStory;',ctx);
const flat=x=>[x,...(x.children||[]).flatMap(flat)];
const EMPTY='기록된 서사 항목이 없습니다';
// 1. an event is projected into the chronology list (title) and its selected detail (row text).
let tree=flat(ctx.build());
assert.ok(tree.some(n=>n.text==='T5 · 도서관 문이 열렸다.'),'the event is listed with its turn');
assert.ok(tree.some(n=>n.tag==='li'&&n.text==='도서관 문이 열렸다.'),'the selected event shows its recorded text');
assert.ok(!tree.some(n=>n.text===EMPTY),'a populated chronology is not shown as empty');
// 2. adding a thread keeps the event, and the threads tab shows the thread.
narrative={events:[{id:'e',turn:5,text:'도서관 문이 열렸다.'}],threads:[{id:'t',summary:'허가자를 확인한다.',status:'open',kind:'question'}]};
tree=flat(ctx.build());assert.ok(tree.some(n=>n.text==='T5 · 도서관 문이 열렸다.'));
ctx.Gui.approvedStoryTab='open';tree=flat(ctx.build());
assert.ok(tree.some(n=>n.text==='허가자를 확인한다.'),'the open thread is listed');
assert.ok(!tree.some(n=>n.text==='T5 · 도서관 문이 열렸다.'),'the threads tab does not list events');
// 3. no narrative at all renders the explicit empty state.
narrative={};assert.ok(flat(ctx.build()).some(n=>n.text===EMPTY),'an empty narrative shows the empty state');
console.log(JSON.stringify({test:'libra_narrative_event_projection_runtime',passed:3,boundary:'production GUI builder with DOM substitutes; not live browser'}));
