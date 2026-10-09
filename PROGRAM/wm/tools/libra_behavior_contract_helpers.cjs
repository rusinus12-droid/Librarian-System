'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const {load}=require('./libra_management_storage_verified_test.cjs');
const root=path.join(__dirname,'..');
function functionExpression(source,name){
 const match=new RegExp('\\b(?:const|let|var)\\s+'+name+'\\s*=\\s*').exec(source);
 assert(match,`function seam missing: ${name}`);const start=match.index+match[0].length;
 for(let end=source.indexOf(';',start);end>=0;end=source.indexOf(';',end+1)){
  const expression=source.slice(start,end);
  try{new vm.Script('('+expression+')');return expression;}catch{}
 }
 throw Error(`function seam is not parseable: ${name}`);
}
async function verifySnapshotAdmission(options={}){
 const f=await load({artifact:true,extraExports:'getActiveChatForCharacter',transformCode:options.transformCode});
 let characterReads=0;f.runtime.getCharacter=async()=>{characterReads++;return null;};
 const chat={id:'snapshot-chat',bindedPersona:'persona-a',localLore:[]};
 const other={id:'preferred-chat',bindedPersona:'persona-a',localLore:[]};
 const char={id:'snapshot-char',chatPage:0,chats:[chat,other]};
 assert.equal(await f.api.getActiveChatForCharacter(char),chat,'admitted active chat reuses exact supplied snapshot');
 assert.equal(await f.api.getActiveChatForCharacter(char,other),other,'preferred chat resolves from supplied snapshot');
 assert.equal(characterReads,0,'no redundant character fetch');
 chat.localLore=[{key:'unowned',comment:'lmai_entity',content:'{"name":"Unowned"}'}];const before=JSON.stringify(char);
 assert.equal(await f.api.getActiveChatForCharacter(char),null,'unowned active snapshot must be rejected');
 assert.equal(JSON.stringify(char),before,'admission must not mutate source');assert.equal(f.writes.length,0,'admission must not write storage');
 return {snapshotReused:true,preferredSnapshotReused:true,unownedRejected:true,writes:0,characterReads};
}
async function verifyIsolatedGraphPersistence(options={}){
 const f=await load({artifact:true,extraExports:'MemoryEngine',transformCode:code=>{
  if(options.transformCode)code=options.transformCode(code);
  const seam=/\bgetRecallDerivedStorageAdapter\s*,/;assert(seam.test(code),'memory API test seam');
  return code.replace(seam,m=>m+'\n__contractCompact:compactHmeGraphForPersistence,__contractRestore:ensureHmeGraphRuntimeShape,__contractSchema:HME_GRAPH_INDEX_SCHEMA,');
 }}),api=f.api.MemoryEngine;
 const node=id=>({id,rowId:id,memoryKey:id,version:1,turn:3,kind:'memory',summary:id});
 const graph={schema:api.__contractSchema,version:api.getHmeGraphIndexVersion(),scopeKey:'fixture-graph',nodes:[node('connected-a'),node('connected-b'),node('isolated')],edges:[{id:'a-b',from:'connected-a',to:'connected-b',fromVersion:1,toVersion:1,weight:.5,layer:'semantic'}]};
 const before=JSON.stringify(graph),persisted=api.__contractCompact(graph);
 assert.deepEqual(Array.from(persisted.nodes,n=>n.id).sort(),graph.nodes.map(n=>n.id).sort(),'persistence retains connected and isolated nodes');
 const restored=api.__contractRestore(JSON.parse(JSON.stringify(persisted)));
 assert(restored,'persisted graph restores');
 assert.deepEqual(Array.from(restored.nodes,n=>n.id).sort(),graph.nodes.map(n=>n.id).sort(),'restart retains isolated nodes');
 assert.equal(restored.edges.length,1,'connected edge survives');assert(restored.byRowId.isolated,'isolated row remains discoverable after restore');
 assert.equal(JSON.stringify(graph),before,'compaction does not mutate source graph');
 return {nodeCount:restored.nodes.length,edgeCount:restored.edges.length,isolatedRestored:true};
}
function verifyFlatWorldLayout(options={}){
 let source=options.source||fs.readFileSync(path.join(root,'src/parts/15a-gui-session-data.js'),'utf8');
 if(options.transformCode)source=options.transformCode(source);
 class Element{
  constructor(){this.children=[];this.dataset={};this.className='';this.style={};this.classList={toggle:()=>{this.toggled=true}};}
  appendChild(n){this.children.push(n);return n;}replaceChildren(...ns){this.children=ns;}querySelector(){return null;}
 }
 const world=new Element(),a=new Element(),b=new Element();world.children=[a,b];const handlers={};
 const overlay={querySelector:s=>s==='#tab-world'?world:null,addEventListener:(name,fn)=>{handlers[name]=fn},contains:()=>true};
 const context=vm.createContext({overlay,document:{createElement:()=>new Element()}});
 for(const name of ['makeGuiSectionLabel','makeGuiAccordion','upgradeWorldPanelLayout','composeSettingsPanelLayout','composeGuiLayoutShell'])vm.runInContext('globalThis.'+name+'=('+functionExpression(source,name)+');',context);
 context.composeGuiLayoutShell();
 assert.deepEqual(world.children,[a,b],'world data page remains flat with original children');
 assert.notEqual(world.dataset.libraLayoutUpgraded,'1','world must not be marked accordion-upgraded');
 assert.equal(typeof handlers.click,'function','layout initializer must install interaction');
 const accordion=new Element(),header={closest:()=>accordion};handlers.click({target:{closest:()=>header}});assert.equal(accordion.toggled,true,'existing accordions remain interactive');
 return {worldChildrenPreserved:true,interactionInstalled:true};
}
module.exports={verifySnapshotAdmission,verifyIsolatedGraphPersistence,verifyFlatWorldLayout,functionExpression};
