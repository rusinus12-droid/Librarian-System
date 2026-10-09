'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
for(const name of ['MemorySuiteStorageClient.source.js','MemorySuiteStorageClient.libra.source.js']){
 const source=fs.readFileSync(path.join(__dirname,'../sdk',name),'utf8');
 const create=new Function(source.replace('  return bridge;', '  return {__inspect: {normalizeServerUrl, validateBootstrapPayload}, dispose: bridge.dispose};')+'\nreturn createMemorySuiteStorageBridge;')();
 const bridge=create({namespace:'flashback',pluginId:'flashback_memory'});
 const {normalizeServerUrl,validateBootstrapPayload}=bridge.__inspect;
 assert.equal(normalizeServerUrl('http://host.docker.internal:47630'),'http://host.docker.internal:47630');
 assert.equal(normalizeServerUrl('http://[::1]:47630'),'http://[::1]:47630');
 assert.throws(()=>normalizeServerUrl('http://host.docker.internal.evil.example:47630'));
 assert.throws(()=>normalizeServerUrl('http://192.168.1.1:47630'));
 const value=validateBootstrapPayload({schema:'memory-suite.storage.bootstrap.v1',dataIdentityContract:'memory-suite.physical-data-identity.v1',dataInstanceId:'S'.repeat(32),token:'fixture',url:'http://127.0.0.1:47630',protocol:{major:1},namespaces:['flashback'],capabilities:new Proxy({},{get:()=>true})},'http://host.docker.internal:47630');
 assert.equal(value.url,'http://host.docker.internal:47630');
 bridge.dispose?.();
}
console.log('docker_connection_contract_test: PASS (exact hostname, IPv6, requested endpoint retained; no live Docker)');
