'use strict';
// Physical preexisting legacy response snapshot at the host read transport seam.
// No SQLite store or remote owner writer is created. Current product preview,
// validation, conflict detection, local publication and rollback run unchanged.
const fs=require('node:fs'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function createSnapshotBridge(bridge,file){
 const calls=[];
 const snapshot=()=>JSON.parse(fs.readFileSync(file,'utf8'));
 const rows=()=>{const data=snapshot();return new Map(Array.isArray(data)?data:data.records);};
 return {calls,api:{...bridge,
   serverBinding:()=>({generation:1,dataInstanceId:'physical-existing-legacy-snapshot'}),
   serverIntegrity:async()=>{calls.push('GET integrity');rows();return{ok:true,result:'ok'};},
   serverKeys:async(space)=>{assert.equal(space,'plugin');calls.push('GET keys');const r=rows();return{keys:[...r.keys()],tombstones:snapshot().tombstones||[],records:[...r].map(([key,value])=>({key,revision:1,digest:digest(value)})),page:{complete:true}};},
   serverGet:async(space,key)=>{assert.equal(space,'plugin');calls.push('GET '+key);const r=rows();return{exists:r.has(key),tombstone:false,value:r.get(key)??null,revision:1,digest:digest(r.get(key)??null)};}
 }};
}
module.exports={createSnapshotBridge};
