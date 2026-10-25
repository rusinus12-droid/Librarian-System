'use strict';
const fs=require('node:fs'),path=require('node:path');
function sync({check=false}={}){
 const root=path.resolve(__dirname,'..');
 const source=fs.readFileSync(path.join(root,'sdk/MemorySuiteSourceInputControls.source.js'),'utf8').trimEnd();
 const start='/* MEMORY SUITE SOURCE INPUT CONTROLS v1 BEGIN */',end='/* MEMORY SUITE SOURCE INPUT CONTROLS v1 END */';
 for(const name of ['LIBRA.js','HAYAKU_Locator_Continuity.js','Flashback_Memory.js']){
  const file=path.join(root,'plugins',name),before=fs.readFileSync(file,'utf8');
  const a=before.indexOf(start),b=before.indexOf(end,a)+end.length;
  if(a<0&&name==='LIBRA.js'&&!check){
   const anchor='/* END LIBRA SOURCE INPUT POLICY */';
   if(before.split(anchor).length!==2)throw Error('source_input_controls_insert_ambiguous:'+name);
   fs.writeFileSync(file,before.replace(anchor,()=>anchor+'\n'+source));continue;
  }
  if(a<0||b<end.length||before.indexOf(start,a+1)>=0)throw Error('source_input_controls_embed_ambiguous:'+name);
  if(before.slice(a,b)!==source){if(check)throw Error('source_input_controls_embed_diverged:'+name);fs.writeFileSync(file,before.slice(0,a)+source+before.slice(b));}
 }
}
module.exports={sync};
if(require.main===module){const args=process.argv.slice(2);if(args.some(x=>x!=='--check'))throw Error('usage: sync_source_input_controls.cjs [--check]');sync({check:args.includes('--check')});console.log('Source input controls: '+(args.includes('--check')?'verified':'synchronized'));}
