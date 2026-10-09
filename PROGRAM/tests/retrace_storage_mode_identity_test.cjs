'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../plugins/RETRACE.js'),'utf8');
const start=source.indexOf('  const memorySuiteOwnerStorageGateFromRows =');
const end=source.indexOf('  const inspectMemorySuiteOwnerStorageGate =',start);assert(start>=0&&end>start);
const owners=['flashback','hayaku','libra','lia'],modes=['plugin_only','server_only'];
const gate=new Function('MEMORY_SUITE_OWNER_STATUS_ORDER','HANDOFF_STORAGE_MODES','MEMORY_SUITE_OWNER_GATE_SCHEMA','text','clone','stableHash64',source.slice(start,end)+'return memorySuiteOwnerStorageGateFromRows;')(owners,modes,'test',v=>String(v??''),v=>JSON.parse(JSON.stringify(v)),v=>v);
const integrity=Object.fromEntries(owners.map(owner=>[owner,{verified:true}]));let passed=0;
for(const base of modes){const rows=owners.map(owner=>({owner,installed:true,connected:true,supported:true,mode:base}));assert(gate(rows,integrity).ready);passed++;
 for(const owner of owners)for(const other of modes.filter(mode=>mode!==base)){
  const result=gate(rows.map(row=>row.owner===owner?{...row,mode:other}:row),integrity);
  assert.equal(result.ready,true);assert.equal(result.commonMode,'per_owner');passed++;
 }
}
for(const owner of owners){const result=gate([{owner,installed:true,connected:true,supported:true,mode:'mirror'}],integrity);assert.equal(result.ready,false);assert.equal(result.reason,'owner_storage_transition_incomplete');passed++;}
const moving=gate(owners.map(owner=>({owner,installed:true,connected:true,supported:true,mode:'plugin_only',transition:{phase:'mirror'}})),integrity);assert.equal(moving.ready,false);assert.equal(moving.reason,'owner_storage_transition_incomplete');passed++;
console.log(JSON.stringify({test:'retrace_storage_mode_identity',passed,source:'deployed gate',mixedModesAllowed:true}));
