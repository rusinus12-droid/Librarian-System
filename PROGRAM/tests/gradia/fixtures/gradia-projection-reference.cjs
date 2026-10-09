'use strict';
// Executes the pinned original functions inside the original test host VM.
// No copied projection implementation is used as the differential oracle.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const assert=require('node:assert/strict');const {load}=require('../host.cjs');
const FULL_SHA256='281d0ca7c8c3fd7d39239387b3f8a0b5d6fcadd217a968b2e1ff5b3fc374a99c';
async function createReference(){
 const sourceFile=path.resolve(__dirname,'./baselines/frozen-G2-GRADIA.js');
 assert.equal(crypto.createHash('sha256').update(fs.readFileSync(sourceFile)).digest('hex'),FULL_SHA256,'reference baseline Full must match pinned original');
 let original;
 const host=await load({sourceFile,testGlobals:{__captureProjectionReference(value){original=value;}},transformSource(source){
  const marker='  const publicApi = Object.freeze({';assert.equal(source.split(marker).length,2);
  return source.replace(marker,'  __captureProjectionReference({ captureLibNativeReadSet, buildRecentChat, resolveSgaCurrentTurn, libNativePromptView, normalizeAideStageOrder, setInputAssist: value => { Runtime.lastInputAssist = value; } });\n'+marker);
 }});
 assert.ok(original,'original baseline sink executed');
 return {
  project(requestView,stagePolicy,{mode='normal',inputAssist=null}={}){
   original.setInputAssist(inputAssist);
   const enabled=new Set(stagePolicy.enabledStages);
   const settings={mode,enableShadowAct:true,enableCharacterAide:enabled.has('aide_character'),enableWorldAide:enabled.has('aide_world'),enablePlotAide:enabled.has('aide_plot'),aideStageOrder:stagePolicy.enabledStages.slice(1),turnWindow:stagePolicy.turnWindows.shadow_act,stageOptions:Object.fromEntries(stagePolicy.enabledStages.map(stage=>[stage,{turn_window:stagePolicy.turnWindows[stage]}])),currentTurnResolution:original.resolveSgaCurrentTurn(requestView)};
   const recent=original.buildRecentChat(requestView,settings);
   return original.captureLibNativeReadSet(requestView,settings,recent);
  },
  resolve:original.resolveSgaCurrentTurn,
  assertNoNetwork(){assert.equal(host.getCalls(),0);},
  sourceFile,FULL_SHA256
 };
}
module.exports={createReference,FULL_SHA256};

// Lexical free-identifier audit, independent of string/regex contents.
function freeIdentifiers(source){
 const acorn=require('../../../tools/gradia/load-dev-dependency.cjs')('acorn');
 const tree=acorn.parse(source,{ecmaVersion:'latest'}),references=[];
 const scope=parent=>({parent,names:new Set()});const root=scope(null);
 function bind(pattern,s){if(!pattern)return;if(pattern.type==='Identifier')s.names.add(pattern.name);else if(pattern.type==='RestElement')bind(pattern.argument,s);else if(pattern.type==='AssignmentPattern'){bind(pattern.left,s);visit(pattern.right,s);}else if(pattern.type==='ObjectPattern')for(const p of pattern.properties)bind(p.type==='RestElement'?p.argument:p.value,s);else if(pattern.type==='ArrayPattern')pattern.elements.forEach(p=>bind(p,s));}
 function visit(n,s){if(!n||typeof n!=='object')return;
  if(n.type==='Identifier'){references.push({name:n.name,scope:s});return;}
  if(n.type==='FunctionDeclaration'||n.type==='FunctionExpression'||n.type==='ArrowFunctionExpression'){if(n.type==='FunctionDeclaration')bind(n.id,s);const child=scope(s);if(n.type==='FunctionExpression')bind(n.id,child);n.params.forEach(p=>bind(p,child));visit(n.body,child);return;}
  if(n.type==='BlockStatement'){const child=scope(s);n.body.forEach(v=>visit(v,child));return;}
  if(n.type==='VariableDeclaration'){for(const d of n.declarations){bind(d.id,s);visit(d.init,s);}return;}
  if(n.type==='MemberExpression'){visit(n.object,s);if(n.computed)visit(n.property,s);return;}
  if(n.type==='Property'){if(n.computed)visit(n.key,s);visit(n.value,s);return;}
  if(n.type==='CatchClause'){const child=scope(s);bind(n.param,child);visit(n.body,child);return;}
  if(n.type==='ForStatement'||n.type==='ForOfStatement'||n.type==='ForInStatement'){const child=scope(s);for(const key of ['init','test','update','left','right','body'])visit(n[key],child);return;}
  if(n.type==='BreakStatement'||n.type==='ContinueStatement')return;
  if(n.type==='LabeledStatement'){visit(n.body,s);return;}
  for(const [key,v]of Object.entries(n)){if(['type','start','end','loc','raw','regex'].includes(key))continue;if(Array.isArray(v))v.forEach(x=>visit(x,s));else if(v&&typeof v==='object')visit(v,s);}
 }
 visit(tree,root);const free=new Set();for(const r of references){let s=r.scope;while(s&&!s.names.has(r.name))s=s.parent;if(!s)free.add(r.name);}return [...free].sort();
}
module.exports.freeIdentifiers=freeIdentifiers;

// Trusted test transport normalization only. This is deliberately not a product
// prototype validator. Known fixture data crosses into the module's realm by
// copying own descriptors, never invoking accessors or toJSON. Unknown/custom
// prototypes remain unchanged so production admission must reject them.
function createRealmAdapter(context){
 const vm=require('node:vm');
 const target=vm.runInContext('({objectPrototype:Object.prototype,arrayPrototype:Array.prototype,makeObject:()=>({}),makeArray:()=>[]})',context);
 const bridge=vm.runInContext('(read,close)=>(function*(){try{for(;;){const step=read();if(step.done)return;yield step.value;}}finally{close();}})()',context);
 const generatorPrototype=Object.getPrototypeOf(Object.getPrototypeOf((function*(){})()));
 const next=Object.getOwnPropertyDescriptor(generatorPrototype,'next').value;
 const finish=Object.getOwnPropertyDescriptor(generatorPrototype,'return').value;
 return function normalize(value){
  const seen=new WeakMap();
  function copy(v){
   if(!v||typeof v!=='object')return v;if(seen.has(v))return seen.get(v);
   const proto=Object.getPrototypeOf(v);
   if(proto===target.objectPrototype||proto===target.arrayPrototype)return v;
   let out;
   if(Array.isArray(v)&&proto===Array.prototype)out=target.makeArray();
   else if(proto===Object.prototype)out=target.makeObject();
   else if(proto===null)out=Object.create(null);
   else if(proto&&Object.getPrototypeOf(proto)===generatorPrototype&&Reflect.ownKeys(proto).length===0&&Reflect.ownKeys(v).length===0){
    out=bridge(()=>{const step=next.call(v);return {done:step.done,value:copy(step.value)};},()=>finish.call(v));seen.set(v,out);return out;
   }else return v;
   seen.set(v,out);
   for(const key of Reflect.ownKeys(v)){if(Array.isArray(v)&&key==='length')continue;const descriptor=Object.getOwnPropertyDescriptor(v,key);if('value'in descriptor)descriptor.value=copy(descriptor.value);Object.defineProperty(out,key,descriptor);}
   if(Array.isArray(v))Object.defineProperty(out,'length',Object.getOwnPropertyDescriptor(v,'length'));
   return out;
  }
  return copy(value);
 };
}
function adaptRealmApi(api,normalize){return Object.fromEntries(Object.entries(api).map(([name,fn])=>[name,(...args)=>fn(...args.map(value=>normalize(value)))]));}
module.exports.createRealmAdapter=createRealmAdapter;
module.exports.adaptRealmApi=adaptRealmApi;
