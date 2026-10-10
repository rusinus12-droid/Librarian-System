'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{test}=require('node:test'),f=require('./fixtures/server_repair_fixture.cjs');
const source=path.join(f.PROGRAM,'server/core/flashback-server-vector-proof.cjs');
test('backup authority is implemented as a bounded independent original-byte proof',()=>{assert(fs.existsSync(source),'missing independent server-owned strong backup proof');assert.equal(typeof require(source),'function');});
test('dot path aliases are rejected before any registered-directory lookup',()=>{
 let lookups=0;const proof=require(source)({resolveBackupById:()=>{lookups++;return null},backupRoot:'/tmp',dataInstanceId:'a'.repeat(32),dataIdentityContract:'memory-suite.physical-data-identity.v1',readIdentity:()=>({dataInstanceId:'a'.repeat(32),dataIdentityContract:'memory-suite.physical-data-identity.v1'}),epochs:()=>({})});
 for(const backupId of ['.','..'])assert.throws(()=>proof.capture({backupId,binding:{dataInstanceId:'a'.repeat(32),epoch:0}}));assert.equal(lookups,0);
});
