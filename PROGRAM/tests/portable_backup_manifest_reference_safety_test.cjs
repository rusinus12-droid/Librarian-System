'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const P=process.env.PROGRAM_UNDER_TEST||path.resolve(__dirname,'..');
const {importBackupArchive}=require(path.join(P,'server/portable/backup_archive.cjs'));
const {createZipFromDirectory}=require(path.join(P,'tools/zip_writer.cjs'));
const root=fs.mkdtempSync(path.join(os.tmpdir(),'ms-archive-ref-'));const source=path.join(root,'source'),target=path.join(root,'target');fs.mkdirSync(source);fs.mkdirSync(target);
const payload=Buffer.from('synthetic store bytes'),hash=crypto.createHash('sha256').update(payload).digest('hex');
fs.writeFileSync(path.join(root,'outside.sqlite'),payload);fs.writeFileSync(path.join(source,'libra.sqlite'),payload);fs.writeFileSync(path.join(source,'scope-catalog.json'),'{}');
const cases=[
 ['relative escape',m=>m.stores.libra.file='../outside.sqlite'],
 ['nested escape',m=>m.stores.libra.file='a/../../outside.sqlite'],
 ['absolute path',m=>m.stores.libra.file=path.join(root,'outside.sqlite')],
 ['Windows path',m=>m.stores.libra.file='C:\\outside.sqlite'],
 ['Windows ADS',m=>m.stores.libra.file='libra.sqlite:secret'],
 ['missing member',m=>m.stores.libra.file='missing.sqlite'],
 ['unknown namespace',m=>{m.stores.unknown=m.stores.libra;delete m.stores.libra;}],
 ['duplicate payload',m=>m.stores.hayaku={...m.stores.libra}],
 ['catalog escape',m=>m.scopeCatalog={file:'../outside.sqlite',sha256:hash}],
 ['malformed digest',m=>m.stores.libra.sha256='fake']
];
try{
 let count=0;
 for(const [label,mutate]of cases){const m={schema:'memory-suite.backup.v1',id:'test',stores:{libra:{file:'libra.sqlite',sha256:hash,bytes:payload.length}}};mutate(m);fs.writeFileSync(path.join(source,'manifest.json'),JSON.stringify(m));const zip=path.join(root,'case-'+count+'.zip');createZipFromDirectory(source,zip,{rootName:'archive'});let dbCalls=0,allocCalls=0;
 assert.throws(()=>importBackupArchive({archivePath:zip,backupRootManual:target,backupIdExists:()=>{allocCalls++;return false;},verifyDatabase:()=>{dbCalls++;return {ok:true};}}),/backup_archive_/i,label);
 assert.equal(allocCalls,0,`${label}: reject metadata before allocating/extracting`);assert.equal(dbCalls,0,`${label}: no outside DB access`);assert.deepEqual(fs.readdirSync(target),[],`${label}: no visible partial import`);count++;}
 assert.deepEqual(fs.readFileSync(path.join(root,'outside.sqlite')),payload);
 console.log(JSON.stringify({test:'portable_backup_manifest_reference_safety',passed:count,externalFileUnchanged:true}));
}finally{fs.rmSync(root,{recursive:true,force:true});}
