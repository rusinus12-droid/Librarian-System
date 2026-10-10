'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const acorn=require('/workspace/scratch/d09f18a13aaa/min-verification-20261004T2120Z/toolchain/node_modules/acorn');
const {runtime}=require('./libra_typed_recall_queue_test.cjs');
const root=path.resolve(__dirname,'..'),dist=process.env.WM_CHECKSUM_DIST||root+'/dist/LIBRA World Manager Full.js';
const plain=x=>JSON.parse(JSON.stringify(x));
function instrument(code){
 const nodes=[],pending=[acorn.parse(code,{ecmaVersion:'latest'})];while(pending.length){const n=pending.pop();if(!n||typeof n!=='object')continue;nodes.push(n);for(const v of Object.values(n))if(Array.isArray(v))pending.push(...v);else if(v&&typeof v==='object')pending.push(v);}
 const matches=nodes.filter(n=>n.type==='VariableDeclarator'&&n.id?.name==='computeRecordChecksum');assert.equal(matches.length,1);const body=matches[0].init.body;
 assert.notEqual(body.type,'BlockStatement');
 const validate=nodes.find(n=>n.type==='VariableDeclarator'&&n.id?.name==='validateIntegrityMetaCore')||nodes.find(n=>n.type==='VariableDeclarator'&&n.id?.name==='validateIntegrityMeta');assert.equal(validate.init.body.type,'BlockStatement');
 const edits=[{at:body.start,text:'(globalThis.__CHECKSUM_OPS__.calls += record?.checksumBatchFixture === true ? 1 : 0,'},{at:body.end,text:')'},{at:validate.init.body.start+1,text:'globalThis.__CHECKSUM_OPS__.validations += record?.checksumBatchFixture === true ? 1 : 0;'}];
 for(const e of edits.sort((a,b)=>b.at-a.at))code=code.slice(0,e.at)+e.text+code.slice(e.at);
 const at=code.lastIndexOf('})();');code=code.slice(0,at)+';globalThis.__CHECKSUM_TEST__={batch:typeof withTypedRecallValidationBatch==="function"?withTypedRecallValidationBatch:null,enumerate:enumerateTypedConsumerBindings,policy:buildProductionRecallConfiguration({embed:{enabled:false}}).policy,secret:SecretKnowledgeCore,witness:typeof TypedChecksumWitness==="undefined"?null:TypedChecksumWitness};'+code.slice(at);
 return 'globalThis.__CHECKSUM_OPS__={calls:0,validations:0};\n'+code;
}
async function fixture(n=12,artifact=dist){
 const r=await runtime(null,{dist:artifact,transformCode:instrument}),c=r.context.__QUEUE_TEST__.consumers;
 const record=r.signed({checksumBatchFixture:true,turnLog:Array.from({length:n},(_,i)=>({turn:i+1,worldSummary:'PUBLIC_WORLD_'+(i+1),notes:['owned parent row '+i]})),consolidated:[]},'world','world_state');
 const entry=r.entry('lmai_world_states','lmai_world_states::core',record);r.chat.localLore=[entry];
 const snapshot=r.snap({currentTurn:100}),units=r.corpus.enumerate(snapshot);assert.equal(units.length,n);
 const policy=r.context.__CHECKSUM_TEST__.policy,com=c.compose({snapshot,policy,baseline:[{key:'world-baseline',text:'PUBLIC_WORLD_BASELINE',bindings:units,required:true}]});
 const finalize=(currentSnapshot=snapshot,p=policy)=>c.finalize({sections:com.sections,currentSnapshot,mode:'hybrid',budget:{maxTokens:20000,maxChars:80000},policy:p});
 const count=()=>r.context.__CHECKSUM_OPS__.calls,reset=()=>{r.context.__CHECKSUM_OPS__.calls=0;r.context.__CHECKSUM_OPS__.validations=0;};reset();
 return {r,c,record,entry,snapshot,units,policy,com,finalize,count,reset};
}

module.exports={fixture,instrument,plain};
