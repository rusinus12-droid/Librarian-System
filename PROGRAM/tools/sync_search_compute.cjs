'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const kernel=require('../sdk/MemorySuiteSearchKernel.source.cjs'),client=require('../sdk/MemorySuiteSearchClient.source.cjs');
const fingerprint=crypto.createHash('sha256').update(kernel.toString()).digest('hex');
const block=`// BEGIN MEMORY SUITE SEARCH\nconst createMemorySuiteSearchKernel = ${kernel.toString()};\nconst MEMORY_SUITE_SEARCH_FINGERPRINT = '${fingerprint}';\nconst createMemorySuiteSearchClient = ${client.toString()};\n// END MEMORY SUITE SEARCH\n`;
for(const name of ['Flashback_Memory.js','HAYAKU_Locator_Continuity.js','LIBRA.js']){
 const target=path.join(root,'plugins',name),before=fs.readFileSync(target,'utf8');
 const after=before.includes('// BEGIN MEMORY SUITE SEARCH')?before.replace(/\/\/ BEGIN MEMORY SUITE SEARCH[\s\S]*?\/\/ END MEMORY SUITE SEARCH\r?\n/,()=>block):before.replace('/* LIBRARIAN SYSTEM COMPUTE SDK v',()=>block+'/* LIBRARIAN SYSTEM COMPUTE SDK v');
 if(after===before&&!before.includes(block))throw Error('search marker missing '+name);
 if(process.argv.includes('--check')){if(after!==before)throw Error('search sync mismatch '+name);}
 else if(after!==before)fs.writeFileSync(target,after);
}
console.log('search compute sync PASS '+fingerprint);
