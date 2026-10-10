'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const G=require('../src/wm-native-host-gate.source.js'),{fixture}=require('./wm-host-gate-fixture.cjs');
test('basic native qualification stays unsupported without trusted capability evidence',async()=>{
  const absent=G.createWmNativeHostGate();assert.equal(absent.inspect().supported,false);
  const getSetOnly=G.createWmNativeHostGate({provider:{async getItem(){return null;},async setItem(){},async keys(){return [];}}});assert.equal(getSetOnly.inspect().supported,false);
  assert.equal((await getSetOnly.acquireFence({operationId:'unsupported',expectedRoute:fixture().state.route})).ok,false);
  assert.equal((await absent.check({route:fixture().state.route,write:true})).ok,true);
  assert.equal((await absent.check({route:{...fixture().state.route,mode:'server_only'},write:true})).ok,false);
  assert.deepEqual(G.qualifiedProductionProfiles,[]);
});
test('basic injected fake host acquires inventory fence and publishes one verified route',async()=>{
  const f=fixture(),expectedRoute=structuredClone(f.state.route);assert.equal(f.gate.inspect().supported,true);
  const fence=await f.gate.acquireFence({operationId:'fake-cutover',expectedRoute});assert.equal(fence.ok,undefined);
  const inventory=await f.gate.captureInventory(fence);assert.equal(inventory.complete,true,JSON.stringify(inventory));assert.equal(inventory.domainCounts.orphan,1);assert.equal(inventory.domainCounts.canonical,0);
  const sourceReceipt=await f.gate.sourceFenceReceipt(fence);assert.equal(sourceReceipt.ok,true);assert.equal(await f.gate.verifySourceFenceReceipt(sourceReceipt.receipt,{expectedRoute}),true);
  const nextRoute={...expectedRoute,mode:'server_only',routeGeneration:'server-2',backendId:'server-backend',datasetId:'server-dataset'};
  const result=await f.gate.publishRoute({fence,expectedRoute,nextRoute,receipt:await f.migrationReceipt('fake-cutover',expectedRoute,nextRoute,inventory)});assert.equal(result.status,'committed',JSON.stringify(result));assert.deepEqual(f.state.route,nextRoute);
  assert.deepEqual(await f.gate.status({operationId:result.operationId,requestFingerprint:result.requestFingerprint}),result);
  assert.equal((await f.gate.status({operationId:'unknown-operation',requestFingerprint:'a'.repeat(64)})).status,'uncertain');
});
