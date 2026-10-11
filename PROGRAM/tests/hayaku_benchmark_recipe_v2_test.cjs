'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const recipeFile=path.resolve(__dirname,'../tools/hayaku_benchmark_recipe_v2.cjs');
assert.ok(fs.existsSync(recipeFile),'versioned recipe must exist without editing legacy pins');
const r=require(recipeFile);
const records=[];
const check=(name,fn)=>{fn();records.push({name,ok:true});};
check('default explicitly retains fixture v1',()=>assert.equal(r.loadRecipe().fixtureVersion,'v1'));
check('v2 is a separate fixture selection',()=>assert.equal(r.loadRecipe({fixtureVersion:'v2'}).fixtureVersion,'v2'));
check('unknown fixture selection fails closed',()=>assert.throws(()=>r.loadRecipe({fixtureVersion:'latest'}),/fixture version/));
check('tampered bytes fail pin verification',()=>assert.throws(()=>r.verifyPin(Buffer.from('changed'),r.PINS.fixtureV1,'test'),/pin mismatch/));
check('both fixtures generate identical gold and corpus bytes at every frozen scale',()=>{
 const a=r.loadRecipe(),b=r.loadRecipe({fixtureVersion:'v2'});
 assert.equal(r.hash(JSON.stringify(a.runner.gold)),r.PINS.gold);
 assert.equal(JSON.stringify(a.runner.gold),JSON.stringify(b.runner.gold));
 for(const n of [10,100,1000,2000])for(const foreign of [false,true])assert.equal(JSON.stringify(a.runner.messages(n,foreign)),JSON.stringify(b.runner.messages(n,foreign)));
 for(const marker of ['BENCH_A1','BENCH_B2','BENCH_D1'])assert.equal(JSON.stringify(a.runner.packet(2001,marker)),JSON.stringify(b.runner.packet(2001,marker)));
});
check('runtime injection records exact source and never loads mutable original runtime',()=>{
 const a=r.loadRecipe(),b=r.loadRecipe({fixtureVersion:'v2'});
 assert.equal(a.fixtureSha256,r.PINS.fixtureV1);assert.equal(b.fixtureSha256,r.PINS.fixtureV2);
 assert.equal(a.runnerSha256,r.PINS.runner);assert.equal(b.runnerSha256,r.PINS.runner);
 assert.equal(a.interceptedRequires.length,1);assert.deepEqual(a.interceptedRequires,b.interceptedRequires);
});
check('baseline and current product revisions remain distinct',()=>assert.notEqual(r.PINS.baselineRevision,r.PINS.currentRevision));
check('nonexact ROOT and runtime require paths fail closed',()=>{
 const recipe=r.loadRecipe();
 assert.equal(typeof recipe.resolveDependency,'function','dependency resolver must be reviewable');
 for(const name of ['C:/Users/rusin/Desktop/LIB/LIB/../LIB/Librarian-System/PROGRAM/tests/fixtures/hayaku_runtime_harness.cjs','C:/Users/rusin/Desktop/LIB/LIB/Librarian-System/PROGRAM/tests/fixtures/changed.cjs','./fixtures/hayaku_runtime_harness.cjs','node:https'])assert.throws(()=>recipe.resolveDependency(name),/unapproved legacy require/);
 assert.throws(()=>recipe.resolveDependency('node:child_process').spawn,/forbids Git\/child/);
});
check('execution requires both guard paths and a private network log',()=>{
 assert.equal(typeof r.verifyExecutionGuard,'function','execution guard must be checked');
 assert.throws(()=>r.verifyExecutionGuard([],undefined,undefined),/explicit --require/);
 assert.throws(()=>r.verifyExecutionGuard(['--require',r.GUARD],'','x'),/NODE_OPTIONS/);
 assert.throws(()=>r.verifyExecutionGuard(['--require',r.GUARD],'--require='+r.GUARD,''),/network log/);
 assert.doesNotThrow(()=>r.verifyExecutionGuard(['--require',r.GUARD],'--require='+r.GUARD,path.resolve(__dirname,'../../../hayaku-logs/guard-unit.log')));
});
console.log(JSON.stringify({schema:'hayaku.recipe-v2-tests.v1',records,assertions:records.length,failed:0}));
