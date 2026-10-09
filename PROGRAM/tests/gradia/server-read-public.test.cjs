'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {load}=require('./host.cjs');
test('public compiled/source binding keeps no credential, connectionless stays unavailable, unbind retires it',async()=>{
 const h=await load({testGlobals:{crypto:crypto.webcrypto}});const api=h.plugin;
 assert.equal(api.getLibReadOnlyStatus().reason,'LIB_READ_CONNECTION_UNAVAILABLE');
 assert.throws(()=>api.bindLibReadOnlyClient({schema:'wrong'}),e=>e.code==='LIB_READ_CONNECTION_UNAVAILABLE');
 const client=Object.freeze({schema:'memory-suite.libra-read-client.v1',pluginId:'serial_gradation_agents_for_rp',openReadSession:async()=>{throw Error('No accepted connection');}});
 const scope={scopeKey:'s',characterId:'c',chatId:'h'};
 const before=JSON.stringify([...h.store]);const result=api.bindLibReadOnlyClient(client,{scope,maxCorpusBytes:33554432});
 assert.equal(result.liveConnectionVerified,false);assert.equal(result.maxCorpusBytes,33554432);assert.equal(api.getLibReadOnlyStatus().status,'bound');
 api.unbindLibReadOnlyClient();assert.equal(api.getLibReadOnlyStatus().status,'unavailable');assert.equal(JSON.stringify([...h.store]),before);assert.equal(h.getCalls(),0);
});
