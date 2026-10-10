'use strict';
const fs=require('node:fs'),path=require('node:path');
const rootIndex=process.argv.indexOf('--root'),root=rootIndex<0?path.resolve(__dirname,'..'):path.resolve(process.argv[rootIndex+1]||'');
const check=process.argv.includes('--check');
const read=name=>fs.readFileSync(path.join(root,'sdk',name),'utf8').trimEnd();
const health=read('MemorySuiteHealthRecovery.source.js');
const owners={ 'LIA_Persona_Linker.js':['LIA',read('MemorySuiteLiaHealth.source.js')], 'RETRACE.js':['RETRACE',read('MemorySuiteRetraceHealth.source.js')] };
const replace=(source,begin,end,canonical,label)=>{
 const a=source.indexOf(begin),b=source.indexOf(end,a);
 if(a<0||b<a||source.indexOf(begin,a+1)!==-1||source.indexOf(end,b+1)!==-1)throw Error('health_embed_ambiguous:'+label);
 return source.slice(0,a)+canonical+source.slice(b+end.length);
};
// Validate every target before changing any product. Other workers' storage,
// source-turn, archive and consent blocks are preserved byte-for-byte.
const plans=['LIBRA.js','HAYAKU_Locator_Continuity.js','Flashback_Memory.js',...Object.keys(owners)].map(name=>{
 const file=path.join(root,'plugins',name),before=fs.readFileSync(file,'utf8');
 let after=replace(before,'/* MEMORY SUITE HEALTH RECOVERY v','/* END MEMORY SUITE HEALTH RECOVERY */',health,name);
 if(owners[name]){const [owner,module]=owners[name];after=replace(after,`/* MEMORY SUITE ${owner} HEALTH ADAPTER v`,`/* END MEMORY SUITE ${owner} HEALTH ADAPTER */`,module,name)}
 return{file,name,before,after};
});
if(check&&plans.some(plan=>plan.before!==plan.after))throw Error('health_embed_diverged:'+plans.filter(plan=>plan.before!==plan.after).map(plan=>plan.name).join(','));
for(const plan of plans){if(!check&&plan.before!==plan.after)fs.writeFileSync(plan.file,plan.after);console.log(plan.name+': health '+(check?'verified':'synchronized'))}
