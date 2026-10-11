'use strict';
// Bounded ZIP32 I/O for portable server snapshots. Live repositories are NEVER
// opened here. This module is run in a worker; restore remains server-owned.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { Transform, Writable } = require('node:stream');
const { pipeline, finished } = require('node:stream/promises');
const { validateArchiveReferences } = require('./backup_archive.cjs');
const LIMITS = Object.freeze({ chunkBytes: 256*1024, maxArchiveBytes: 2*1024**3,
  maxEntryBytes: 2*1024**3, maxTotalBytes: 4*1024**3, maxEntries:4096,
  maxManifestBytes:2*1024**2, maxCentralBytes:4*1024**2 });
const fail = reason => { throw Object.assign(new Error('portable_zip_'+reason),{statusCode:422}); };
const crcTable = Uint32Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=(n>>>1)^((n&1)?0xedb88320:0);return n>>>0;});
const updateCRC=(crc,b)=>{for(const n of b)crc=crcTable[(crc^n)&255]^(crc>>>8);return crc>>>0;};
async function writeAll(handle,bytes,position=null) {
  let n=0; while(n<bytes.length){const r=await handle.write(bytes,n,bytes.length-n,position==null?null:position+n);if(!r.bytesWritten)fail('short_write');n+=r.bytesWritten;}
}
async function readExact(handle,length,position) {
  const b=Buffer.alloc(length);let n=0;while(n<length){const r=await handle.read(b,n,length-n,position+n);if(!r.bytesRead)fail('truncated');n+=r.bytesRead;}return b;
}
async function sha256File(file) {const h=crypto.createHash('sha256');for await(const b of fs.createReadStream(file,{highWaterMark:LIMITS.chunkBytes}))h.update(b);return h.digest('hex');}
async function safeDirectory(file) {const s=await fsp.lstat(file);if(!s.isDirectory()||s.isSymbolicLink())fail('directory_invalid');}
function safeName(name) {
 if(typeof name!=='string'||!name||name.length>1024||name.startsWith('/')||/[\\:<>"|?*\x00-\x1f\x7f]/.test(name))fail('path_unsafe');
 const parts=name.replace(/\/$/,'').split('/');
 if(parts.some(p=>!p||p==='.'||p==='..'||/[. ]$/.test(p)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))fail('path_unsafe');
 return name;
}
function textName(b){try{return safeName(new TextDecoder('utf-8',{fatal:true}).decode(b));}catch(e){fail('name_invalid');}}
function dosStamp(d=new Date()) {return {time:(d.getHours()<<11)|(d.getMinutes()<<5)|(d.getSeconds()>>1),date:((Math.max(1980,d.getFullYear())-1980)<<9)|((d.getMonth()+1)<<5)|d.getDate()};}
async function exportArchive({backupDir,archivePath,onProgress=()=>{}}) {
 const source=path.resolve(backupDir),dest=path.resolve(archivePath);await safeDirectory(source);
 const files=[];async function walk(dir,rel=''){for(const e of await fsp.readdir(dir,{withFileTypes:true})){const name=rel?rel+'/'+e.name:e.name,p=path.join(dir,e.name),s=await fsp.lstat(p);if(s.isSymbolicLink())fail('symlink');if(s.isDirectory())await walk(p,name);else if(s.isFile()){safeName(name);files.push({name,p,size:s.size,mtimeMs:s.mtimeMs});}else fail('file_kind');}}
 await walk(source);files.sort((a,b)=>a.name.localeCompare(b.name));
 if(!files.length||files.length>LIMITS.maxEntries)fail('entry_limit');
 const total=files.reduce((s,f)=>s+f.size,0);if(total>LIMITS.maxTotalBytes||files.some(f=>f.size>LIMITS.maxEntryBytes))fail('expanded_limit');
 const mf=files.find(f=>f.name==='manifest.json');if(!mf||mf.size>LIMITS.maxManifestBytes)fail('manifest_missing');
 const manifest=JSON.parse(await fsp.readFile(mf.p,'utf8'));
 let root='Librarian-Server-Backup',refs,allowed;
 if(manifest.schema==='memory-suite.backup.v1'){
  validateArchiveReferences(manifest,files.map(f=>({name:root+'/'+f.name})),root);
  refs=new Map(Object.values(manifest.stores).map(v=>[v.file,v]));if(manifest.scopeCatalog)refs.set(manifest.scopeCatalog.file,manifest.scopeCatalog);
  allowed=new Set(['manifest.json',...refs.keys()]);
 }else if(manifest.schema==='librarian.portable-migration.v1'){
  root='Librarian-Migration-Backup';
  if(!Array.isArray(manifest.members)||!manifest.members.length||manifest.members.length>LIMITS.maxEntries-1)fail('migration_members');
  refs=new Map();allowed=new Set(['manifest.json']);
  for(const m of manifest.members){
   if(!m||typeof m.file!=='string'||!m.file||typeof m.sha256!=='string'||!/^[a-f0-9]{64}$/i.test(m.sha256)||!Number.isSafeInteger(m.bytes)||m.bytes<0)fail('migration_member_meta');
   safeName(m.file);if(refs.has(m.file))fail('migration_member_duplicate');refs.set(m.file,m);allowed.add(m.file);
  }
 }else fail('manifest_schema');
 if(files.some(f=>!allowed.has(f.name))||allowed.size!==files.length)fail('unexpected_file');
 await fsp.mkdir(path.dirname(dest),{recursive:true,mode:0o700});
 const tmp=dest+'.tmp-'+crypto.randomUUID();let handle,offset=0,processed=0;const central=[];
 const append=async b=>{if(offset+b.length>LIMITS.maxArchiveBytes)fail('archive_limit');await writeAll(handle,b);offset+=b.length;};
 try{
  handle=await fsp.open(tmp,'wx',0o600);
  for(const f of files){
   const name=Buffer.from(root+'/'+f.name),stamp=dosStamp(),start=offset,header=Buffer.alloc(30);
   header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x0800,6);header.writeUInt16LE(8,8);header.writeUInt16LE(stamp.time,10);header.writeUInt16LE(stamp.date,12);header.writeUInt16LE(name.length,26);
   await append(header);await append(name);const dataAt=offset;
   let crc=0xffffffff,raw=0;const hash=crypto.createHash('sha256');
   const meter=new Transform({transform(b,enc,cb){raw+=b.length;processed+=b.length;if(raw>f.size||processed>LIMITS.maxTotalBytes)return cb(Error('portable_zip_source_changed'));crc=updateCRC(crc,b);hash.update(b);cb(null,b);}});
   const sink=new Writable({write(b,enc,cb){append(b).then(()=>cb(),cb);}});
   await pipeline(fs.createReadStream(f.p,{highWaterMark:LIMITS.chunkBytes}),meter,zlib.createDeflateRaw({level:6,chunkSize:LIMITS.chunkBytes}),sink);
   const after=await fsp.lstat(f.p);if(after.isSymbolicLink()||raw!==f.size||after.size!==f.size||after.mtimeMs!==f.mtimeMs)fail('source_changed');
   const digest=hash.digest('hex');if(refs.has(f.name)&&digest!==refs.get(f.name).sha256)fail('source_digest');
   const compressed=offset-dataAt,crc32=(crc^0xffffffff)>>>0,metadata=Buffer.alloc(12);
   metadata.writeUInt32LE(crc32);metadata.writeUInt32LE(compressed,4);metadata.writeUInt32LE(raw,8);await writeAll(handle,metadata,start+14);
   const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50);c.writeUInt16LE((3<<8)|20,4);c.writeUInt16LE(20,6);c.writeUInt16LE(0x0800,8);c.writeUInt16LE(8,10);c.writeUInt16LE(stamp.time,12);c.writeUInt16LE(stamp.date,14);c.writeUInt32LE(crc32,16);c.writeUInt32LE(compressed,20);c.writeUInt32LE(raw,24);c.writeUInt16LE(name.length,28);c.writeUInt32LE((0o100600<<16)>>>0,38);c.writeUInt32LE(start,42);central.push(c,name);
   onProgress({phase:'packing',processedBytes:processed,totalBytes:total});
  }
  const centralAt=offset;for(const b of central)await append(b);const centralBytes=offset-centralAt;
  if(centralBytes>LIMITS.maxCentralBytes)fail('central_limit');
  const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(centralBytes,12);end.writeUInt32LE(centralAt,16);await append(end);
  await handle.sync();await handle.close();handle=null;await fsp.rename(tmp,dest);
  return {ok:true,archivePath:dest,bytes:offset,sha256:await sha256File(dest),files:files.length,expandedBytes:total,format:'zip32'};
 }catch(e){if(handle)await handle.close().catch(()=>{});await fsp.rm(tmp,{force:true}).catch(()=>{});throw e;}
}
async function inspectZip(file) {
 const s=await fsp.lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.size<22||s.size>LIMITS.maxArchiveBytes)fail('archive_size');
 const h=await fsp.open(file,'r');
 try{
  const tailBytes=Math.min(s.size,65557),tail=await readExact(h,tailBytes,s.size-tailBytes);let at=-1;
  for(let i=tail.length-22;i>=0;i--)if(tail.readUInt32LE(i)===0x06054b50&&i+22+tail.readUInt16LE(i+20)===tail.length){at=i;break;}
  if(at<0)fail('eocd');const eocdAt=s.size-tailBytes+at;
  const disk=tail.readUInt16LE(at+4),centralDisk=tail.readUInt16LE(at+6),nDisk=tail.readUInt16LE(at+8),count=tail.readUInt16LE(at+10),size=tail.readUInt32LE(at+12),offset=tail.readUInt32LE(at+16);
  if(disk||centralDisk||nDisk!==count)fail('multidisk');if(count===65535||size===0xffffffff||offset===0xffffffff)fail('zip64_not_supported');
  if(!count||count>LIMITS.maxEntries||size>LIMITS.maxCentralBytes||offset+size!==eocdAt)fail('central_bounds');
  const central=await readExact(h,size,offset),entries=[],names=new Set();let c=0,total=0;
  for(let i=0;i<count;i++){
   if(c+46>central.length||central.readUInt32LE(c)!==0x02014b50)fail('central_entry');
   const flags=central.readUInt16LE(c+8),method=central.readUInt16LE(c+10),crc=central.readUInt32LE(c+16),compressed=central.readUInt32LE(c+20),raw=central.readUInt32LE(c+24),nl=central.readUInt16LE(c+28),xl=central.readUInt16LE(c+30),cl=central.readUInt16LE(c+32),startDisk=central.readUInt16LE(c+34),attrs=central.readUInt32LE(c+38),localAt=central.readUInt32LE(c+42);
   if(c+46+nl+xl+cl>central.length||!nl||startDisk)fail('central_entry_bounds');
   if(flags&~0x0808||![0,8].includes(method))fail('encoding_unsupported');
   const type=(attrs>>>16)&0o170000;if(type&&type!==0o100000&&type!==0o040000)fail('file_kind');
   const name=textName(central.subarray(c+46,c+46+nl)),key=name.normalize('NFC').toLowerCase();if(names.has(key))fail('duplicate_path');names.add(key);
   if(raw>LIMITS.maxEntryBytes||compressed>LIMITS.maxArchiveBytes||localAt===0xffffffff)fail('entry_limit');total+=raw;if(total>LIMITS.maxTotalBytes)fail('expanded_limit');
   if(localAt+30>offset)fail('local_bounds');const local=await readExact(h,30,localAt);
   if(local.readUInt32LE(0)!==0x04034b50||local.readUInt16LE(6)!==flags||local.readUInt16LE(8)!==method)fail('local_header_mismatch');
   const lnl=local.readUInt16LE(26),lxl=local.readUInt16LE(28),dataAt=localAt+30+lnl+lxl;
   if(dataAt+compressed>offset||lnl!==nl)fail('local_bounds');const lname=await readExact(h,lnl,localAt+30);if(textName(lname)!==name)fail('local_name_mismatch');
   let endAt=dataAt+compressed;
   if(flags&8){if(endAt+12>offset)fail('descriptor_missing');const first=await readExact(h,4,endAt),signature=first.readUInt32LE(0)===0x08074b50,n=signature?16:12;if(endAt+n>offset)fail('descriptor_bounds');const dd=await readExact(h,n,endAt),p=signature?4:0;if(dd.readUInt32LE(p)!==crc||dd.readUInt32LE(p+4)!==compressed||dd.readUInt32LE(p+8)!==raw)fail('descriptor_mismatch');endAt+=n;}
   else if(local.readUInt32LE(14)!==crc||local.readUInt32LE(18)!==compressed||local.readUInt32LE(22)!==raw)fail('local_size_mismatch');
   if(name.endsWith('/')&&(raw!==0||compressed!==0))fail('directory_payload');
   entries.push({name,flags,method,crc,compressed,raw,localAt,dataAt,endAt});c+=46+nl+xl+cl;
  }
  if(c!==central.length)fail('central_extra');
  const ordered=entries.slice().sort((a,b)=>a.localAt-b.localAt);let end=0;for(const e of ordered){if(e.localAt!==end)fail('overlap_or_gap');end=e.endAt;}if(end!==offset)fail('local_extra');
  return {entries,bytes:s.size,expandedBytes:total};
 }finally{await h.close();}
}
async function extractEntry(file,entry,sink,onProgress=()=>{}) {
 let n=0,crc=0xffffffff;const hash=crypto.createHash('sha256');
 if(!entry.compressed){if(entry.raw||entry.crc)fail('empty_entry_invalid');sink.end();await finished(sink);return {bytes:0,sha256:crypto.createHash('sha256').digest('hex')};}
 const meter=new Transform({transform(b,enc,cb){n+=b.length;if(n>entry.raw||n>LIMITS.maxEntryBytes)return cb(Error('portable_zip_inflate_limit'));crc=updateCRC(crc,b);hash.update(b);onProgress(b.length);cb(null,b);}});
 const streams=[fs.createReadStream(file,{start:entry.dataAt,end:entry.dataAt+entry.compressed-1,highWaterMark:LIMITS.chunkBytes})];const inflater=entry.method===8?zlib.createInflateRaw({chunkSize:LIMITS.chunkBytes}):null;if(inflater)streams.push(inflater);
 await pipeline(...streams,meter,sink);if(inflater&&inflater.bytesWritten!==entry.compressed)fail('compressed_trailing_bytes');
 if(n!==entry.raw||((crc^0xffffffff)>>>0)!==entry.crc)fail('crc_or_size');return {bytes:n,sha256:hash.digest('hex')};
}
async function importArchive({archivePath,backupRootManual,stagingRoot,expectedDatabaseSchemaVersion,expectedProtocolMajor=1,requiredNamespaces=null,expectedArchiveSha256=null,onProgress=()=>{}}) {
 const archiveSha256=await sha256File(archivePath);if(expectedArchiveSha256&&archiveSha256!==expectedArchiveSha256)fail('archive_digest');
 const info=await inspectZip(archivePath),entries=info.entries;
 const roots=new Set(entries.map(e=>e.name.split('/')[0]));if(roots.size!==1)fail('single_root_required');const root=[...roots][0];
 const me=entries.find(e=>e.name===root+'/manifest.json');if(!me||me.raw>LIMITS.maxManifestBytes)fail('manifest_missing');
 const pieces=[];await extractEntry(archivePath,me,new Writable({write(b,e,cb){pieces.push(b);cb();}}));
 let manifest;try{manifest=JSON.parse(Buffer.concat(pieces).toString('utf8'));}catch(_){fail('manifest_json');}
 if(manifest?.schema!=='memory-suite.backup.v1')fail('manifest_schema');
 validateArchiveReferences(manifest,entries,root);
 if(manifest.protocol?.major!==expectedProtocolMajor)fail('protocol_incompatible');
 if(expectedDatabaseSchemaVersion!=null&&manifest.databaseSchemaVersion!==expectedDatabaseSchemaVersion)fail('database_schema_incompatible');
 if(requiredNamespaces&&(requiredNamespaces.some(ns=>!manifest.stores?.[ns])||!manifest.scopeCatalog))fail('full_snapshot_required');
 const refs=new Map(Object.entries(manifest.stores).map(([ns,s])=>[s.file,{...s,namespace:ns}]));if(manifest.scopeCatalog)refs.set(manifest.scopeCatalog.file,manifest.scopeCatalog);
 const allowed=new Set(['manifest.json',...refs.keys()]);
 for(const e of entries)if(!e.name.endsWith('/')&&!allowed.has(e.name.slice(root.length+1)))fail('unexpected_file');
 const id=new Date().toISOString().replace(/[:.]/g,'-')+'_'+crypto.randomBytes(8).toString('hex')+'_portable';
 await fsp.mkdir(stagingRoot,{recursive:true,mode:0o700});
 const disk=await fsp.statfs(stagingRoot);if(Number(disk.bavail)*Number(disk.bsize)<info.expandedBytes+64*1024**2)fail('insufficient_disk_space');
 const temp=path.join(path.resolve(stagingRoot),id),dest=path.join(path.resolve(backupRootManual),id);await fsp.mkdir(temp,{recursive:true,mode:0o700});let processed=0;
 try{
  for(const e of entries){
   if(e.name.endsWith('/')||e===me)continue;
   const rel=e.name.slice(root.length+1),out=path.resolve(temp,rel);if(!out.startsWith(temp+path.sep))fail('path_escape');await fsp.mkdir(path.dirname(out),{recursive:true,mode:0o700});
   const r=await extractEntry(archivePath,e,fs.createWriteStream(out,{flags:'wx',mode:0o600}),n=>{processed+=n;onProgress({phase:'inspecting',processedBytes:processed,totalBytes:info.expandedBytes});});
   const meta=refs.get(rel);if(!meta||r.sha256!==meta.sha256||meta.bytes!=null&&r.bytes!==meta.bytes)fail('manifest_digest_or_size');
   const handle=await fsp.open(out,'r+');try{await handle.sync();}finally{await handle.close();}
  }
  const {DatabaseSync}=require('node:sqlite'),verified={};
  for(const [ns,meta] of Object.entries(manifest.stores)){
   const db=new DatabaseSync(path.join(temp,meta.file),{readOnly:true});try{const result=db.prepare('PRAGMA integrity_check').all();if(result.length!==1||Object.values(result[0])[0]!=='ok')fail('database_integrity');const kv=db.prepare('PRAGMA table_info(kv)').all().map(r=>r.name),ops=db.prepare('PRAGMA table_info(operations)').all().map(r=>r.name);if(!['space','key','value_json','deleted','revision','digest','updated_at'].every(c=>kv.includes(c))||!['operation_id','fingerprint','response_json','created_at'].every(c=>ops.includes(c)))fail('database_tables_incompatible');verified[ns]={sha256:meta.sha256,integrity:'ok'};}finally{db.close();}
  }
  if(manifest.scopeCatalog){let catalog;try{catalog=JSON.parse(await fsp.readFile(path.join(temp,manifest.scopeCatalog.file),'utf8'));}catch(_){fail('catalog_json');}if(catalog?.schema!=='memory-suite.scope-catalog.v1'||!catalog.namespaces||Array.isArray(catalog.namespaces)||typeof catalog.namespaces!=='object')fail('catalog_schema');}
  const persisted={...manifest,id,kind:'manual',importedAt:new Date().toISOString(),importedFromId:String(manifest.id||'')};
  const mh=await fsp.open(path.join(temp,'manifest.json'),'wx',0o600);try{await mh.writeFile(JSON.stringify(persisted,null,2)+'\n');await mh.sync();}finally{await mh.close();}
  await fsp.mkdir(backupRootManual,{recursive:true,mode:0o700});await fsp.rename(temp,dest);
  return {ok:true,backupId:id,backupDir:dest,manifest:persisted,verified,sha256:archiveSha256,bytes:info.bytes,expandedBytes:info.expandedBytes};
 }catch(e){await fsp.rm(temp,{recursive:true,force:true}).catch(()=>{});throw e;}
}
module.exports={LIMITS,exportArchive,importArchive,inspectZip,extractEntry,sha256File,safeName};
