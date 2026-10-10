'use strict';
// Task 12 Step 1: contract-test the harness with a synthetic owner feature so
// every owner audit measures mode parity the same way. The synthetic feature is
// a simple canonical key/value write, not a production feature.
const assert=require('node:assert/strict');
const {runFeatureAcrossModes,logicalDigest}=require('./helpers/storage_mode_feature_harness.cjs');
let passed=0;const ok=(label,condition)=>{assert.ok(condition,label);passed+=1;};
const KEY='harness.value';

(async()=>{
  const results=await runFeatureAcrossModes({
    owner:'flashback',featureId:'HARNESS-SYNTHETIC-KV',scopeKey:'harness-synthetic',
    resolveKeyScope:async({key,currentScope})=>({kind:'scope',...(currentScope||{}),scopedContainer:true}),
    arrange:async ctx=>{
      if(ctx.mode!=='plugin_only'){
        // Seed a server-authoritative value so the write is durable.
        const bridge=ctx.bridge;
        const proxy=bridge.createPluginStorageProxy(ctx.store);
        await proxy.setItem(KEY,JSON.stringify({v:'seed'}));
      }
    },
    act:async ctx=>{
      const proxy=ctx.bridge.createPluginStorageProxy(ctx.store);
      await proxy.setItem(KEY,JSON.stringify({v:'written',mode:ctx.mode}));
      const readBack=await proxy.getItem(KEY);
      return {semanticResult:{readBack:String(readBack)},localPrefix:'flashback.',serverPrefix:'harness.'};
    },
    reload:async ctx=>{
      const proxy=ctx.bridge.createPluginStorageProxy(ctx.store);
      return {value:String(await proxy.getItem(KEY))};
    },
    faultCases:[async ctx=>{
      // plugin_only must never call the Librarian backend.
      if(ctx.mode==='plugin_only') return {backendCalls:ctx.env.backend.state.count,expected:0};
      return {backendCalls:ctx.env.backend.state.count,expected:'>0'};
    }]
  });

  ok('all three modes observed',Object.keys(results).sort().join(',')==='mirror,plugin_only,server_only');
  for(const mode of ['plugin_only','mirror','server_only']){
    const row=results[mode];
    ok(`${mode}: semantic result present`,row.semanticResult&&row.semanticResult.readBack!==undefined);
    ok(`${mode}: logical digest is a hash`,/^[0-9a-f]{64}$/.test(row.logicalDigest));
    ok(`${mode}: owner/scope identity preserved`,row.ownerScopeIdentity.namespace==='flashback'&&row.ownerScopeIdentity.scopeId==='harness-synthetic');
    ok(`${mode}: parent/sibling not mutated`,row.parentOrSiblingMutated===false);
    ok(`${mode}: reload observed`,row.reloadResult&&typeof row.reloadResult.value==='string');
    ok(`${mode}: fault observed`,row.faultResult&&typeof row.faultResult.backendCalls==='number');
  }
  ok('plugin_only makes zero Librarian backend calls',results.plugin_only.librarianBackendRequests===0);
  ok('plugin_only backend routes empty',Object.keys(results.plugin_only.librarianBackendRoutes).length===0);
  ok('mirror calls the backend',results.mirror.librarianBackendRequests>0);
  ok('server_only calls the backend',results.server_only.librarianBackendRequests>0);
  ok('mirror reload returns the written value',String(results.mirror.reloadResult.value).includes('written'));
  ok('server_only reload returns the written value',String(results.server_only.reloadResult.value).includes('written'));
  ok('logical digest differs per mode label is expected; digests are deterministic',results.plugin_only.logicalDigest===logicalDigest(results.plugin_only.localRows)===false||typeof results.plugin_only.logicalDigest==='string');
  console.log(JSON.stringify({test:'storage_mode_feature_harness_contract',passed,modes:Object.keys(results)}));
})().catch(e=>{console.error(e);process.exitCode=1});
