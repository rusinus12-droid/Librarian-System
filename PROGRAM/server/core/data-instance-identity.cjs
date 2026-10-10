'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const schema='memory-suite.data-instance-seed.v1';
const contract='memory-suite.physical-data-identity.v1';
const identityPath=dataDir=>path.join(path.resolve(dataDir),'config','data-instance.json');
const invalid=()=>Object.assign(new Error('data_instance_identity_invalid'),{code:'DATA_INSTANCE_IDENTITY_INVALID'});
function readDataInstanceIdentity(dataDir){
 const file=identityPath(dataDir);let seed;
 try{
  const before=fs.lstatSync(file,{bigint:true});
  const regular=stat=>stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=4096n;
  const same=(a,b)=>['dev','ino','size','mtimeNs','ctimeNs'].every(k=>a[k]===b[k]);
  if(!regular(before))throw invalid();
  let fd,bytes;
  try{
   fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
   const opened=fs.fstatSync(fd,{bigint:true});if(!regular(opened)||!same(before,opened))throw invalid();
   const buffer=Buffer.alloc(4097);let length=0;
   while(length<buffer.length){const n=fs.readSync(fd,buffer,length,buffer.length-length,length);if(n===0)break;length+=n;}
   if(length>4096)throw invalid();
   const after=fs.fstatSync(fd,{bigint:true}),current=fs.lstatSync(file,{bigint:true});
   if(!regular(after)||!regular(current)||!same(opened,after)||!same(after,current))throw invalid();
   bytes=buffer.subarray(0,length);
  }finally{if(fd!==undefined)try{fs.closeSync(fd);}catch{throw invalid();}}
  seed=JSON.parse(bytes.toString('utf8'));
 }catch(error){if(error.code==='ENOENT')throw Object.assign(new Error('data_instance_identity_unavailable'),{code:'DATA_INSTANCE_IDENTITY_UNAVAILABLE'});throw invalid();}
 if(seed?.schema!==schema||typeof seed.nonce!=='string'||!/^[-_A-Za-z0-9]{43}$/.test(seed.nonce)||typeof seed.createdAt!=='string'||!Number.isFinite(Date.parse(seed.createdAt)))throw invalid();
 // The portable seed alone names a logical copy. Bind it to the actual root:
 // byte-identical DATA copied to another folder must not share live authority.
 // realpath unifies filesystem aliases; no token or root path is published.
 let root=fs.realpathSync.native(path.resolve(dataDir));if(process.platform==='win32')root=root.toLowerCase();
 const physical=fs.statSync(root,{bigint:true});
 const id=crypto.createHash('sha256').update(contract+'\0'+seed.nonce+'\0'+root+'\0'+physical.dev+'\0'+physical.ino,'utf8').digest('base64url').slice(0,32);
 return {dataInstanceId:id,dataIdentityContract:contract};
}
function ensureDataInstanceIdentity(dataDir){
 const file=identityPath(dataDir);fs.mkdirSync(path.dirname(file),{recursive:true});
 if(!fs.existsSync(file)){
  const bytes=Buffer.from(JSON.stringify({schema,nonce:crypto.randomBytes(32).toString('base64url'),createdAt:new Date().toISOString()})+'\n');let fd;
  try{fd=fs.openSync(file,'wx',0o600);let offset=0;while(offset<bytes.length)offset+=fs.writeSync(fd,bytes,offset,bytes.length-offset);fs.fsyncSync(fd);}
  catch(error){
   // Only remove a seed created by this attempt; preserve pre-existing identities.
   if(fd!==undefined){fs.closeSync(fd);fd=undefined;fs.rmSync(file,{force:true});}
   if(error.code!=='EEXIST')throw error;
  }
  finally{if(fd!==undefined)fs.closeSync(fd);}
  // Never overwrite a pre-existing partial/corrupt identity after a race.
 }
 return readDataInstanceIdentity(dataDir);
}
module.exports={ensureDataInstanceIdentity,readDataInstanceIdentity,identityPath,contract};
