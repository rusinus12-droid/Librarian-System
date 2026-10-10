'use strict';
// Test-only VM execution: all variants are in memory and network is blocked by the gate.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..'),gate=fs.readFileSync(path.join(__dirname,'libra_minified_artifact_test.cjs'),'utf8');
const full=fs.readFileSync(path.join(root,'dist/LIBRA World Manager Full.js'),'utf8');
const min=fs.readFileSync(path.join(root,'dist/LIBRA World Manager.js'),'utf8');
async function execute(fullCode,minCode){
 let result;const fakeFs={...fs,readFileSync(file,...args){if(String(file).endsWith('LIBRA World Manager Full.js'))return fullCode;if(String(file).endsWith('LIBRA World Manager.js'))return minCode;return fs.readFileSync(file,...args)}};
 const context={require:n=>n==='fs'?fakeFs:require(n),__dirname,console:{log:s=>{result=JSON.parse(s)},error:s=>{result=JSON.parse(s)}},process:{env:{},exit:()=>{}},Buffer,setTimeout,clearTimeout,setInterval,clearInterval,AbortController,TextEncoder,TextDecoder,URL};
 await vm.runInNewContext(gate,context);return result;
}
(async()=>{
 // Compression properties are observations, not functionality. A valid plugin with
 // equivalent extra comments can have a higher ratio and more comment lines.
 const padded=min+'\n'+('// harmless release documentation\n'.repeat(Math.ceil(full.length/32)));
 let r=await execute(full,padded);assert.equal(r.ok,true,r.error);console.log('PASS valid artifact despite higher ratio/comment count');
 const renamedFull=full.replace(/^\/\/@version .+$/m,'//@version 99.0.0');
 const renamedMin=min.replace(/^\/\/@version .+$/m,'//@version 99.0.0');
 r=await execute(renamedFull,renamedMin);assert.equal(r.ok,true,r.error);console.log('PASS compatible version change');
 r=await execute(full,full);assert.equal(r.ok,false);assert.match(r.error,/unminified_fallback/);console.log('PASS rejected unminified fallback');
 r=await execute(full,min.replace(/^\/\/@version .+$/m,'//@version 99.0.0'));assert.equal(r.ok,false);assert.match(r.error,/same_version/);console.log('PASS rejected mismatched artifact pair');
 r=await execute(full,min.replace(/^\/\/@arg .+\n/m,''));assert.equal(r.ok,false);assert.match(r.error,/all_arg_declarations/);console.log('PASS rejected lost host argument');
 r=await execute(full,min+'\nthis is invalid !!!');assert.equal(r.ok,false);assert.ok(r.error);console.log('PASS rejected invalid JavaScript');
})().catch(e=>{console.error(e);process.exitCode=1});
