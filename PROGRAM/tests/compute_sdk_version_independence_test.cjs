'use strict';
// Runs only read-only source contracts before runtime construction. In particular,
// this never executes compute_bridge's protocol/binding/digest scenarios.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module');const {test}=require('node:test');
const specs=[
 ['compute_bridge_test.cjs','const context = {','const createMemorySuiteComputeBridge','one compute factory'],
 ['storage-compute-mode-contract-v2.test.cjs','const integrations =','const VALID_MODES = new Set','VALID_MODES'],
 ['hayaku_sparse_rrf_compute_pilot_test.cjs','const sparseSignals =','MemorySuiteHayakuComputeBridge.execute(', 'MemorySuiteHayakuComputeBridge'],
 ['lia_world_lore_compute_pilot_test.cjs','const values = new Map','MemorySuiteLiaComputeBridge.execute(', 'MemorySuiteLiaComputeBridge']
];
function run([name,end],transform=s=>s){
 const file=path.join(__dirname,name),requireHere=createRequire(file);let contract=fs.readFileSync(file,'utf8');
 if(end){const at=contract.indexOf(end);assert(at>0,'runtime boundary found');contract=contract.slice(0,at);}
 const wrappedFs=Object.create(fs);wrappedFs.readFileSync=(target,...args)=>{const value=fs.readFileSync(target,...args);return typeof value==='string'&&/MemorySuiteComputeClient\.source\.js|plugins[\\/]/.test(String(target))?transform(value):value;};
 vm.runInNewContext(contract,{require:n=>n==='node:fs'?wrappedFs:requireHere(n),__dirname,console:{log(){}}},{filename:file});
}
for(const spec of specs){
 test(spec[0]+': benign SDK comment version change passes',()=>run(spec,s=>s.replaceAll('COMPUTE SDK v0.3.6','COMPUTE SDK v9.8.7')));
 test(spec[0]+': missing required capability still fails',()=>{run(spec);assert.throws(()=>run(spec,s=>s.replaceAll(spec[2],'__removed_capability__')),e=>e.code==='ERR_ASSERTION'&&e.message.includes(spec[3]));});
}
