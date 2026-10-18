'use strict';
// The Compute SDK and the memory-search client were retired from the plugins: search runs
// locally in each plugin. This check keeps the old embedded block from coming back.
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
for(const name of ['Flashback_Memory.js','HAYAKU_Locator_Continuity.js','LIBRA.js']){
 const source=fs.readFileSync(path.join(root,'plugins',name),'utf8');
 if(/BEGIN MEMORY SUITE SEARCH|createMemorySuiteSearchClient|LIBRARIAN SYSTEM COMPUTE SDK v/.test(source))throw Error('retired search compute embedded in '+name);
}
console.log('search compute retired PASS');
