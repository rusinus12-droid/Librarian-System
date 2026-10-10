'use strict';
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const source=fs.readFileSync(path.join(root,'sdk','MemorySuiteNativeBranchTargetStorage.source.js'),'utf8').trimEnd();
const start='/* RisuAI native-branch target storage preparation v1.';
const end='/* End RisuAI native-branch target storage preparation */';
const handoffEnd='/* End target-only handoff storage preparation */';
for(const name of ['LIBRA.js','HAYAKU_Locator_Continuity.js','Flashback_Memory.js','LIA_Persona_Linker.js']){
  const file=path.join(root,'plugins',name); let text=fs.readFileSync(file,'utf8');
  const a=text.indexOf(start), b=a>=0?text.indexOf(end,a):-1;
  if(a>=0){ if(b<a) throw Error('native_branch_storage_embed_end_missing:'+name); text=text.slice(0,a)+source+text.slice(b+end.length); }
  else { const h=text.indexOf(handoffEnd); if(h<0) throw Error('handoff_embed_anchor_missing:'+name); const at=h+handoffEnd.length; text=text.slice(0,at)+'\n'+source+text.slice(at); }
  if((text.split(start).length-1)!==1) throw Error('native_branch_storage_embed_ambiguous:'+name);
  fs.writeFileSync(file,text,'utf8'); console.log(name+': native branch target storage embedded');
}
