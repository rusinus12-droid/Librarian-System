'use strict';
// Historical source-edit SDK files remain inert compatibility artifacts.
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),check=process.argv.includes('--check');
if(process.argv.slice(2).some(v=>v!=='--check'))throw Error('unknown_source_input_sync_argument');
const input=fs.readFileSync(path.join(root,'sdk/MemorySuiteSourceInput.libra.source.js'),'utf8').trimEnd();
for(const name of ['LIBRA.js','HAYAKU_Locator_Continuity.js','Flashback_Memory.js']){
 const file=path.join(root,'plugins',name),text=fs.readFileSync(file,'utf8');
 const start='/* LIBRA SOURCE INPUT POLICY v1',end='/* END LIBRA SOURCE INPUT POLICY */';
 const a=text.indexOf(start),b=text.indexOf(end,a)+end.length;
 if(a<0||b<end.length||text.indexOf(start,a+1)>=0)throw Error('ambiguous_source_input_embed:'+name);
 if(text.slice(a,b)!==input){if(check)throw Error('source_input_embed_diverged:'+name);fs.writeFileSync(file,text.slice(0,a)+input+text.slice(b));}
 console.log(name+': shared input policy '+(check?'verified':'synchronized'));
}
