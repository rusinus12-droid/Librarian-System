const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
// Everything a plugin layers over the host stays below 50 (source-edit dialogs 41-43,
// host notice cards 44-46). The approved six-product GUI renders inside each plugin's own
// fullscreen container (api.showContainer('fullscreen')), so a closed, exact list of
// container-scoped layers may sit higher. Any other declaration >= 50 still fails.
const DESIGN_SYSTEM_MARKER='Librarian Suite GUI — 공용 디자인 시스템';
// Shared design-system stylesheet: frame-scoped layers only (absolute/sticky inside .frame).
const DESIGN_SYSTEM_LAYERS=[
 ['.proto-bar{position:sticky;top:0;z-index:100;',100],
 ['.overlay{position:absolute;inset:0;z-index:50;',50],
 ['.toasts{position:absolute;right:16px;bottom:16px;z-index:70;',70]
];
const CONTAINER_ROOTS={
 'HAYAKU_Locator_Continuity.js':[['#${LEDGER_VIEWER_ROOT_ID}{position:fixed;inset:0;width:100%;height:100dvh;z-index:2147483000;',2147483000]],
 'LIA_Persona_Linker.js':[["shell.id='lia-update-notice';\n    shell.style.cssText='position:fixed;inset:0;z-index:10000;",10000]]
};
const pattern=/(?:\bz-index\s*:\s*|\bzIndex\s*[:=]\s*['"]?)(\d+)/g;
for(const file of ['LIBRA.js','HAYAKU_Locator_Continuity.js','Flashback_Memory.js','LIA_Persona_Linker.js']){
 const source=fs.readFileSync(path.join(__dirname,'../plugins',file),'utf8');
 const all=[...source.matchAll(pattern)];
 assert(all.length>0);
 const allowed=new Map();
 const lines=source.split('\n');let offset=0,designLines=0;
 for(const line of lines){
  if(line.includes(DESIGN_SYSTEM_MARKER)){
   designLines++;
   for(const [decl,value] of DESIGN_SYSTEM_LAYERS){const at=line.indexOf(decl);assert(at>=0,`${file}: design-system layer missing ${decl}`);allowed.set(offset+at+decl.lastIndexOf('z-index'),value);}
   const high=[...line.matchAll(pattern)].filter(m=>Number(m[1])>=50);
   assert.equal(high.length,DESIGN_SYSTEM_LAYERS.length,`${file}: design-system stylesheet adds an unexpected high layer`);
  }
  offset+=line.length+1;
 }
 assert.equal(designLines,1,`${file}: exactly one embedded design-system stylesheet`);
 for(const [decl,value] of CONTAINER_ROOTS[file]||[]){const at=source.indexOf(decl);assert(at>=0&&source.indexOf(decl,at+1)<0,`${file}: fullscreen container root ${decl}`);allowed.set(at+decl.lastIndexOf('z-index'),value);}
 const offenders=all.filter(m=>Number(m[1])>=50&&allowed.get(m.index)!==Number(m[1]));
 assert.deepEqual(offenders.map(m=>source.slice(Math.max(0,m.index-60),m.index+20)),[],file);
 const hostValues=all.filter(m=>!allowed.has(m.index)).map(m=>Number(m[1]));
 assert(hostValues.length>0&&hostValues.every(v=>v<50),file);
 console.log(`${file}: PASS ${all.length} declarations, host-layer max=${Math.max(...hostValues)}, container-scoped=${allowed.size}`);
}
