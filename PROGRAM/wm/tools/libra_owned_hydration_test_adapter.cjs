'use strict';
const assert=require('node:assert/strict');
const {load}=require('./libra_recall_test_runtime.cjs');
function instrument(code){
 const ast=require('acorn').parse(code,{ecmaVersion:'latest'}),nodes=[],pending=[ast],edits=[];
 while(pending.length){const n=pending.pop();if(!n||typeof n!=='object')continue;nodes.push(n);for(const v of Object.values(n))if(Array.isArray(v))pending.push(...v);else if(v&&typeof v==='object')pending.push(v);}
 const find=name=>nodes.find(n=>n.type==='VariableDeclarator'&&n.id?.name===name);
 const inlinedFacts=!find('evaluateHydrationFacts')&&nodes.find(n=>n.type==='ArrowFunctionExpression'&&n.params?.map(p=>p.name).join(',')==='facts,identity'&&code.slice(n.start,n.end).includes('fact.signed'));
 const factSource=inlinedFacts?code.slice(inlinedFacts.start,inlinedFacts.end):null;if(inlinedFacts)edits.push({at:inlinedFacts.body.start+1,text:'globalThis.__HYDRATION_COUNTS__.facts++;'});
 const storage=find('LibraDataStorage'),ret=storage.init.callee.body.body.filter(n=>n.type==='ReturnStatement');assert.equal(ret.length,1);
 edits.push({at:ret[0].start,text:'globalThis.__HYDRATION_PRIVATE__={sources:validationSources,identity:typeof inspectHydrationIdentity==="undefined"?null:inspectHydrationIdentity,core:typeof inspectHydrationCore==="undefined"?null:inspectHydrationCore,evaluate:typeof evaluateHydrationFacts==="undefined"?globalThis.__HYDRATION_EVALUATE__:evaluateHydrationFacts};'});
 const core=find('inspectHydrationCore')||find('inspectHydrationEntries');for(const n of nodes)if(core&&n.start>core.init.start&&n.end<core.init.end&&n.type==='CallExpression'&&n.callee?.object?.name==='JSON'&&n.callee?.property?.name==='parse'){edits.push({at:n.start,text:'(globalThis.__HYDRATION_COUNTS__.parses++,'},{at:n.end,text:')'});}
 const functions={inspectHydrationCore:'full',inspectHydrationEntries:'public',evaluateHydrationFacts:'facts',computeRecordChecksum:'checksums',preparePersonaContext:'publicPrepare'};
 for(const [name,count]of Object.entries(functions)){const n=find(name);if(n?.init?.body?.type==='BlockStatement')edits.push({at:n.init.body.start+1,text:`globalThis.__HYDRATION_COUNTS__.${count}++;`});else if(n?.init?.type==='ArrowFunctionExpression'){edits.push({at:n.init.body.start,text:`(globalThis.__HYDRATION_COUNTS__.${count}++,`},{at:n.init.body.end,text:')'});}}
 for(const n of nodes)if(n.type==='AssignmentExpression'&&n.left?.name==='OwnedHydrationValidation'&&n.right?.type==='CallExpression'){
  const body=n.right.callee.body.body,returns=body.filter(n=>n.type==='ReturnStatement');if(returns.length===1)edits.push({at:returns[0].start,text:'globalThis.__HYDRATION_STATE__={active:()=>activeCapsules.size,state:token=>capsules.get(token)};'});
 }
 for(const e of edits.sort((a,b)=>b.at-a.at))code=code.slice(0,e.at)+e.text+code.slice(e.at);
 const close=code.lastIndexOf('})();');code=code.slice(0,close)+'\n;globalThis.__OWNED_HYDRATION__=typeof OwnedHydrationValidation==="undefined"?null:OwnedHydrationValidation;globalThis.__ORIGINAL_HYDRATION_VALIDATOR__=typeof originalHydrationValidator==="undefined"?null:originalHydrationValidator;globalThis.__HYDRATION_COMPAT__=RisuCompat;globalThis.__HYDRATION_RUNTIME_SCOPE__=getChatRuntimeScopeKey;globalThis.__HYDRATION_LEGACY_SCOPE__=getLegacyChatRuntimeScopeKey;\n'+code.slice(close);
 code=code.replace(/RisuCompat\.onUnload\(async/g,'((handler)=>(globalThis.__HYDRATION_UNLOAD__=handler,RisuCompat.onUnload(handler)))(async');return 'globalThis.__HYDRATION_COUNTS__={full:0,public:0,facts:0,checksums:0,publicPrepare:0,parses:0};\n'+(factSource?'globalThis.__HYDRATION_EVALUATE__='+factSource+';\n':'')+code;
}
const plain=v=>JSON.parse(JSON.stringify(v));
async function fixture(options={}){
 const r=await load({dist:options.dist,transformCode:options.transformCode?code=>options.transformCode(instrument(code)):instrument});const NativeDate=Date;r.context.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[1900000000000]))}static now(){return 1900000000000}};r.chat.bindedPersona='default';r.d=r.api.LibraDataStorage;r.v=r.context.__HYDRATION_PRIVATE__;r.h=r.context.__OWNED_HYDRATION__;r.compat=r.context.__HYDRATION_COMPAT__;r.scope=r.d.scopeKeyFor(r.char,r.chat);r.runtime=r.context.__HYDRATION_RUNTIME_SCOPE__(r.chat,r.char);r.key=r.d.storageKeyFor(r.scope);r.legacy=r.context.__HYDRATION_LEGACY_SCOPE__(r.chat,r.char);
 r.signed=(extra={})=>{const record={id:'owned',name:'Owned',background:{occupation:'Archivist'},meta:{created:1},...extra};r.api.IntegrityMetaManager.applyIntegrityMeta(record,{domain:'entity',scopeKey:r.runtime,recordId:'owned',turn:1});return {key:'lmai_entity::owned',comment:'lmai_entity',content:JSON.stringify(record)}};
 r.put=(entries=[r.signed()],extra={})=>{r.raw=JSON.stringify({version:'1.0',scopeKey:r.scope,resetGeneration:0,entries,...extra});r.store.set(r.key,r.raw);return r.raw};r.put();
 r.contextFor=()=>({char:r.char,chat:r.chat,scopeKey:r.scope,runtimeScopeKey:r.runtime,runtimeChatId:r.chat.id,canonicalEnvelopeVerified:true});
 r.admission={scopeKey:r.scope,runtimeScopeKey:r.runtime,resetGeneration:0};r.open=()=>{assert.ok(r.h,'private request bridge exists');return r.h.open({admission:r.admission,guard:()=>true})};
 r.observe=async token=>{const observation=await r.h.read(token,r.scope);return {observation,result:r.h.inspect(token,observation,observation.read?.entries||[],r.contextFor(),true)}};
 r.counts=r.context.__HYDRATION_COUNTS__;r.resetCounts=()=>Object.keys(r.counts).forEach(k=>r.counts[k]=0);return r;
}
module.exports={instrument,fixture,plain};
