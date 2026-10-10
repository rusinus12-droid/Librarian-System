'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module');
const root=path.resolve(__dirname,'..');
// Run the actual tool with a read-through filesystem; writes are captured in memory.
// A blanket active-writer resync would change the three preserved consumer bodies.
function runTool(tool, replacements={}) {
 const filename=path.join(root,'tools',tool),writes=[];
 const f={...fs,readFileSync(file,options){const key=path.relative(root,String(file)).split(path.sep).join('/');if(Object.hasOwn(replacements,key)){const bytes=Buffer.from(replacements[key]);return typeof options==='string'||options?.encoding?bytes.toString(typeof options==='string'?options:options.encoding):bytes;}return fs.readFileSync(file,options);},writeFileSync(file,bytes){writes.push({file,bytes:Buffer.from(bytes)});}};
 const req=createRequire(filename),processMock={argv:[process.execPath,filename],execPath:process.execPath,stdout:{write(){}},env:process.env,exitCode:0};
 const context={require(name){return name==='node:fs'?f:name==='node:child_process'?{execFileSync(){}}:req(name);},__dirname:path.dirname(filename),__filename:filename,process:processMock,console:{log(){},error(){}},Buffer,module:{exports:{}},exports:{}};
 try {vm.runInNewContext(fs.readFileSync(filename,'utf8'),context,{filename});}catch(error){error.proposedWrites=writes;throw error;}
 return {writes,exit:processMock.exitCode};
}
test('SDK checker accepts the exact current per-owner variants',()=>{assert.equal(runTool('check_sdk_sync.cjs').exit,0);});
test('default SDK sync preserves the six current plugin bodies and WM receipt',()=>{assert.deepEqual(runTool('sync_embedded_sdk.cjs').writes.map(row=>path.basename(row.file)),[]);});
module.exports={runTool};

const {STORAGE_VARIANTS,extractStorageSdk}=require('../tools/lib/sdk_variants.cjs');
for(const name of ['LIA_Persona_Linker.js','RETRACE.js','GRADIA.js'])test('preserved consumer changes fail closed: '+name,()=>{
 const source=fs.readFileSync(path.join(root,'plugins',name),'utf8'),sdk=extractStorageSdk(source,name);
 const replacements={['plugins/'+name]:source.replace(sdk,sdk.replace('STORAGE SDK v1.8.24','STORAGE SDK v1.8.25'))};
 assert.equal(runTool('check_sdk_sync.cjs',replacements).exit,1);
 assert.throws(()=>runTool('sync_embedded_sdk.cjs',replacements),error=>/preserved_storage_sdk_changed/.test(error.message)&&error.proposedWrites.length===0);
});
test('duplicate storage SDK blocks and unregistered variants are refused',()=>{
 const name='LIBRA.js',source=fs.readFileSync(path.join(root,'plugins',name),'utf8');
 assert.equal(runTool('check_sdk_sync.cjs',{['plugins/'+name]:source+'\n'+extractStorageSdk(source,name)}).exit,1);
 assert.throws(()=>require('../tools/lib/sdk_variants.cjs').expectedStorageSdk(root,'unknown.js',source),/variant_unknown/);
});
test('active LIBRA never accepts the standard owner variant',()=>{
 const name='LIBRA.js',source=fs.readFileSync(path.join(root,'plugins',name),'utf8');
 const standard=fs.readFileSync(path.join(root,STORAGE_VARIANTS['Flashback_Memory.js'].source),'utf8').trimEnd();
 const replacements={['plugins/'+name]:source.replace(extractStorageSdk(source,name),standard)};
 assert.equal(runTool('check_sdk_sync.cjs',replacements).exit,1);
 const result=runTool('sync_embedded_sdk.cjs',replacements);
 assert.equal(result.writes.length,1);assert.equal(result.writes[0].bytes.toString(),source);
});
