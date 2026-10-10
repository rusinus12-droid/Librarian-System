'use strict';
const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
const {runtime}=require('./libra_typed_recall_queue_test.cjs'),instrument=require('./checksum-cost-instrument.cjs');
const root=path.resolve(__dirname,'..'),base=path.resolve(root,'../wm-native-cache-dispatch-repair-20261006T1221Z');
(async()=>{const results=[];
 for(const flavor of ['Full','Min'])for(const [entities,relations] of [[12,6],[24,12],[48,24]]){
  const rows=[];
  for(const artifact of [base,root]){
   const dist=artifact+'/dist/'+(flavor==='Full'?'LIBRA World Manager Full.js':'LIBRA World Manager.js'),r=await runtime(null,{dist,transformCode:instrument});
   const entry=(comment,record)=>r.entry(comment,comment+'::'+record.id,r.signed(record,comment==='lmai_entity'?'entity':'relation',record.id));
   r.chat.localLore=[...Array.from({length:entities},(_,i)=>entry('lmai_entity',{id:'person-'+i,name:'Observer '+i,meta:{created:2,aliases:['Witness-'+i,'Witness-'+i]},currentState:{summary:'Checkpoint '+i}})),...Array.from({length:relations},(_,i)=>entry('lmai_relation',{id:'link-'+i,entityA:'Witness-'+(i*2),entityB:'Observer '+(i*2+1),relationType:'survey partners',currentStatus:{summary:'Route observation '+i},meta:{created:2}}))];
   const snapshot=r.snap({currentTurn:20,viewerId:'main_request'}),count=r.context.__CHECKSUM_COST__;for(const key of Object.keys(count))count[key]=0;
   const units=r.corpus.enumerate(snapshot),enumeration={...count};assert.equal(units.length,entities);
   const eligible=units.filter(u=>r.corpus.adapters[u.family].eligibility(u,snapshot).eligible);assert.equal(eligible.length,entities);
   rows.push({artifact,enumeration,withEligibility:{...count},output:JSON.parse(JSON.stringify(eligible.map(u=>({identity:u.identity,text:u.text,sourceRefs:u.sourceRefs,roles:u.roles}))))});assert.equal(r.state.calls.length,0);
  }
  assert.deepEqual(rows[0].output,rows[1].output);assert.equal(rows[0].enumeration.checksums,entities+relations);assert.equal(rows[1].enumeration.checksums,entities+relations);assert.equal(rows[0].withEligibility.checksums,2*entities+relations);assert.equal(rows[1].withEligibility.checksums,2*entities+relations);
  const result={flavor,entities,relations,rows};results.push(result);console.log('PUBLIC_COST '+JSON.stringify({...result,rows:rows.map(({output,...r})=>r)}));
 }
 fs.writeFileSync(root+'/evidence/PUBLIC-COST.json',JSON.stringify(results,null,2)+'\n');
})().catch(e=>{console.error(e);process.exitCode=1});
