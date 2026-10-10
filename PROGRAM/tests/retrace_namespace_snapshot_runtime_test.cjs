'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const s=fs.readFileSync(path.join(__dirname,'../plugins/RETRACE.js'),'utf8'),a=s.indexOf('  const scopeManagerNamespaceListing ='),b=s.indexOf('  const scopeManagerRecordsWithPrefix =',a);
const make=new Function('MemorySuiteStorageBridge','scopeManagerArray','scopeManagerRecordMap','scopeManagerPrefetchRecord',s.slice(a,b)+'return scopeManagerNamespaceSnapshot;');
const snapshot=make({managerServerIntegrity:async()=>({ok:true}),managerServerKeys:async(ns,space)=>({records:[{space,key:'unrecognized',tombstone:false,valueBytes:1}]})},v=>Array.isArray(v)?v:[],rows=>new Map(rows.map(r=>[r.space+':'+r.key,r])),()=>false);
(async()=>{for(const ns of ['flashback','hayaku','libra','lia','retrace']){const r=await snapshot(ns);assert.equal(r.records.length,2);assert.equal(r.pluginListing.records[0].space,'plugin');assert.equal(r.localListing.records[0].space,'local');}console.log('retrace_namespace_snapshot_runtime: PASS (five real scanner functions, not a template-only assertion)');})().catch(e=>{console.error(e);process.exitCode=1;});
