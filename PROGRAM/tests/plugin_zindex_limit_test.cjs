const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
for(const file of ['LIBRA.js','HAYAKU_Locator_Continuity.js','Flashback_Memory.js','LIA_Persona_Linker.js']){
 const source=fs.readFileSync(path.join(__dirname,'../plugins',file),'utf8');
 const values=[...source.matchAll(/(?:\bz-index\s*:\s*|\bzIndex\s*[:=]\s*['"]?)(\d+)/g)].map(m=>Number(m[1]));
 assert(values.length>0);assert(values.every(v=>v<50),file);console.log(`${file}: PASS ${values.length} declarations, max=${Math.max(...values)}`);
}
