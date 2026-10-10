'use strict';
let completed=false;
process.on('beforeExit',()=>{if(!completed){console.error('OBSERVER_TEST_INCOMPLETE: assertions did not complete');process.exitCode=1;}});
// The exact private helper is evaluated separately only to observe its temporary
// Map lifetime. Actual Full/Min recordCleanup and payloads have artifact tests.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(path.resolve(__dirname,'../src/parts/10o-typed-recall-consumers.js'),'utf8');
const start=source.indexOf('        const copyRetainedObserver = value => {'),end=source.indexOf('        const recordCleanup =',start);
assert.ok(start>=0&&end>start,'exact retained-observer helper must exist');const helper=source.slice(start,end);
(async()=>{
 assert.equal(typeof global.gc,'function');const pools=[],lengths=[];let constructed=0;
 class ObservedMap extends Map{constructor(){super();constructed++;pools.push(new WeakRef(this));}set(k,v){assert.equal(typeof k,'string');assert.equal(typeof v,'string');lengths.push(k.length);return super.set(k,v);}}
 const context={Map:ObservedMap};vm.createContext(context);vm.runInContext(helper+'\nglobalThis.copy=copyRetainedObserver;',context);
 const text='a'.repeat(1024),short='b'.repeat(1023),retained=[context.copy({a:text,b:text,c:short}),context.copy({a:text})];
 assert.equal(constructed,2);assert.deepEqual(lengths,[1024,1024]);
 for(let i=0;i<3;i++){await new Promise(setImmediate);global.gc();}
 assert.ok(pools.every(p=>p.deref()===undefined),'per-copy pools must collect with result still live');
 assert.ok(retained.every(Object.isFrozen));assert.equal(retained[0].a,text);assert.equal(retained[1].a,text);
 console.log(JSON.stringify({pass:true,poolsConstructed:constructed,poolsCollected:2,stringOnlyPool:true,thresholdBoundary:true}));
 completed=true;
})().catch(e=>{console.error(e);process.exitCode=1});
