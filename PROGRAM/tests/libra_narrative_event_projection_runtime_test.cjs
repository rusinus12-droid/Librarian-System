'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(process.env.LIBRA_TEST_PLUGIN||path.join(__dirname,'../plugins/LIBRA.js'),'utf8');
const start=source.indexOf('const BOOK_NARRATIVE_GROUPS ='),end=source.indexOf('const buildBookHostLineagePanel =',start);assert.ok(start>=0&&end>start);
let narrative={events:[{id:'e',turn:5,text:'도서관 문이 열렸다.'}]};
const el=(tag,attrs={},children=[])=>({tag,...attrs,children:children.filter(Boolean)});
const buildBookBrowse=({id,items,renderDetail})=>el('div',{dataset:{bookBrowse:id}},[
  el('nav',{},items.map(item=>el('button',{text:item.title}))),
  items.length?renderDetail(items[0]):null
]);
const buildBookEmptyState=(eyebrow,title,description)=>el('section',{text:title},[el('p',{text:description})]);
const ctx=vm.createContext({bookReferenceTypographyCss:"",LibraMemoryCore:{peekSnapshot:()=>({})},canonicalReaderBinding:()=>({scopeKey:"test"}),Gui:{bookNarrativeTab:"events"},worldManagerSnapshotView:()=>({narrative,throughTurn:5}),guiAsObject:v=>v||{},guiAsArray:v=>Array.isArray(v)?v:[],text:String,compact:(value,max)=>String(value??'').slice(0,max),narrativeDirectionScopeKey:()=>'',worldManagerIsUnified:()=>true,guiEl:el,buildBookBrowse,buildBookEmptyState,bookDomainFreshness:()=>el('span'),bookSelectStorySection:()=>{}});
vm.runInContext(source.slice(start,end)+';globalThis.build=buildBookNarrativeTocProjection;',ctx);
const flat=x=>[x,...(x.children||[]).flatMap(flat)];
let tree=flat(ctx.build());assert.ok(tree.some(n=>n.text==='T5 · 도서관 문이 열렸다.'));assert.ok(tree.some(n=>n.text==='도서관 문이 열렸다.'));assert.ok(!tree.some(n=>n.text==='아직 목차가 비어 있습니다'));
narrative={events:[{id:'e',turn:5,text:'도서관 문이 열렸다.'}],threads:[{id:'t',summary:'허가자를 확인한다.',status:'open',kind:'question'}]};tree=flat(ctx.build());assert.ok(tree.some(n=>n.text==='T5 · 도서관 문이 열렸다.'));ctx.Gui.bookNarrativeTab='threads';tree=flat(ctx.build());assert.ok(tree.some(n=>n.text==='허가자를 확인한다.'));
narrative={};assert.ok(flat(ctx.build()).some(n=>n.text==='아직 서사 기록이 없습니다'));
console.log(JSON.stringify({test:'libra_narrative_event_projection_runtime',passed:3,boundary:'production GUI builder with DOM substitutes; not live browser'}));
