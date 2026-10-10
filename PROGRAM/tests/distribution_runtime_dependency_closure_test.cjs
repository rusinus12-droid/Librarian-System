'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const builder=require('../tools/build_distribution.cjs');
const zip=require('../tools/zip_writer.cjs');
const root=path.resolve(__dirname,'../..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'librarian-runtime-closure-'));
function copy(source,target,predicate,base=source){
 for(const entry of fs.readdirSync(source,{withFileTypes:true})){
  const from=path.join(source,entry.name),relative=path.relative(base,from).split(path.sep).join('/');
  if(entry.isDirectory())copy(from,target,predicate,base);
  else if(entry.isFile()&&predicate(relative)){const to=path.join(target,...relative.split('/'));fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(from,to);}
 }
}
try{
 const staged=path.join(temp,'stage'),unpacked=path.join(temp,'unpacked'),archive=path.join(temp,'runtime.zip');
 copy(path.join(root,'PROGRAM'),path.join(staged,'PROGRAM'),rel=>!rel.startsWith('plugins/')&&builder.shouldCopyRuntimeProgram(rel));
 copy(path.join(root,'UPDATER'),path.join(staged,'UPDATER'),builder.shouldCopyUpdater);
 zip.createZipFromDirectory(staged,archive);
 for(const entry of zip.readZipEntries(archive)){const file=path.join(unpacked,...entry.name.split('/'));fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,entry.bytes);}
 // Require actual ZIP bytes, never the source-tree server or a source SDK fallback.
 const serverPath=path.join(unpacked,'PROGRAM/server/server.cjs');
 const server=require(serverPath);
 assert.equal(typeof server.createMemorySuiteServer,'function');
 assert.equal(typeof require(path.join(unpacked,'PROGRAM/tools/portable_export_stopped.cjs')).exportStopped,'function');
 assert.equal(fs.existsSync(path.join(unpacked,'PROGRAM/sdk/WmStorageContracts.source.js')),true);
 const {inspectExtractedRuntime}=require('../tools/verify_runtime_archive.cjs');
 const closure=inspectExtractedRuntime(unpacked);assert.equal(closure.verified,true);assert.ok(closure.localRequires>100);
 const dependency=path.join(unpacked,'PROGRAM/sdk/WmStorageContracts.source.js'),saved=fs.readFileSync(dependency);
 fs.unlinkSync(dependency);
 assert.throws(()=>inspectExtractedRuntime(unpacked),/distribution_runtime_dependency_missing/,'a loaded module cache must not hide a missing ZIP member');
 fs.writeFileSync(dependency,saved);
 const lazy=path.join(unpacked,'PROGRAM/server/lazy-negative.cjs');
 fs.writeFileSync(lazy,"module.exports=()=>require('./missing-lazy.cjs');\n");
 assert.throws(()=>inspectExtractedRuntime(unpacked),/distribution_runtime_dependency_missing/,'lazy transitive edges are checked before invocation');
 fs.writeFileSync(lazy,"module.exports=()=>require /* lazy */ ( /* path */ './missing-lazy.cjs' /* end */ );\n");
 assert.throws(()=>inspectExtractedRuntime(unpacked),/distribution_runtime_dependency_missing/,'whitespace and comments cannot hide a literal dependency');
 fs.writeFileSync(lazy,"module.exports=()=>require('unpackaged-external-module');\n");
 assert.throws(()=>inspectExtractedRuntime(unpacked),/distribution_runtime_dependency_external/,'NODE_PATH cannot supply an external runtime dependency');
 fs.writeFileSync(path.join(temp,'outside.cjs'),'module.exports={};\n');
 fs.writeFileSync(lazy,"module.exports=()=>require('../../../outside.cjs');\n");
 assert.throws(()=>inspectExtractedRuntime(unpacked),/distribution_runtime_dependency_outside_archive/,'source siblings cannot satisfy a packaged dependency');
 fs.unlinkSync(lazy);
 console.log('distribution_runtime_dependency_closure_test: PASS (actual ZIP server/exporter dependency load)');
}finally{fs.rmSync(temp,{recursive:true,force:true});}
