'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..');
for(const relative of ['UPDATER/core/data-identity.cjs','PROGRAM/server/core/data-instance-identity.cjs']) {
 const identity=require(path.join(root,relative));
 for(const stage of ['write','partial','fsync']) {
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'lib-seed-'));
  const originalWrite=fs.writeSync,originalSync=fs.fsyncSync;let injected=false,writes=0,first;
  const fail=()=>{injected=true;throw Object.assign(Error('fixture seed ENOSPC'),{code:'ENOSPC'});};
  try {
   fs.writeSync=function(fd,buffer,offset,length,...args){if(stage==='write')return fail();if(stage==='partial'){if(writes++)return fail();return originalWrite.call(fs,fd,buffer,offset,Math.min(8,length),...args);}return originalWrite.call(fs,fd,buffer,offset,length,...args);};
   fs.fsyncSync=function(...args){if(stage==='fsync')return fail();return originalSync.apply(fs,args);};
   try {identity.ensureDataInstanceIdentity(data);}catch(e){first=e;}
  } finally {fs.writeSync=originalWrite;fs.fsyncSync=originalSync;}
  assert(injected);assert.equal(first?.code,'ENOSPC');assert.equal(fs.existsSync(identity.identityPath(data)),false,'failed seed must never be published');
  const recovered=identity.ensureDataInstanceIdentity(data);assert.match(recovered.dataInstanceId,/^[-_A-Za-z0-9]{32}$/);assert.deepEqual(identity.ensureDataInstanceIdentity(data),recovered);
  assert.deepEqual(fs.readdirSync(path.join(data,'config')),['data-instance.json']);
  // Existing invalid identities belong to the caller and must not be overwritten.
  fs.writeFileSync(identity.identityPath(data),'invalid');assert.throws(()=>identity.ensureDataInstanceIdentity(data),e=>e.code==='DATA_INSTANCE_IDENTITY_INVALID');assert.equal(fs.readFileSync(identity.identityPath(data),'utf8'),'invalid');
  console.log('PASS',relative,stage);
 }
}
