'use strict';
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const source=JSON.parse(fs.readFileSync(path.join(root,'sdk/MemorySuiteGuiShared.source.json'),'utf8'));
const {verifyApprovedCss}=require('./lib/approved_gui_css.cjs');
const patterns={diagnostics:/    if \(!globalThis\.__librarianDiag\) \{[\s\S]*?globalThis\.__librarianDiag = report;\r?\n    \}/,theme:/      const THEME_KEYS = \[[\s\S]*?globalThis\.__memorySuiteTheme = bridge;/,tokens:/  \/\* --- MemorySuite shared design tokens[\s\S]*?@media\(prefers-reduced-motion:reduce\)\{:root\{--ms-motion:0s\}\}/};
for(const name of ['Flashback_Memory.js','HAYAKU_Locator_Continuity.js','LIBRA.js']){
 const file=path.join(root,'plugins',name);let text=fs.readFileSync(file,'utf8');
 for(const [key,re]of Object.entries(patterns)){
  const match=text.match(re);
  if(!match&&key==='tokens'){
   // The approved six-product design replaced the former --ms-* owner GUI
   // scale. Verify its real assembly inputs instead of re-inserting retired
   // styling. SDK diagnostics/theme synchronization below is still mandatory.
   verifyApprovedCss(root,name,text);
   continue;
  }
  if(!match)throw Error(name+': missing '+key);
  if(process.argv.includes('--check')){if(match[0].replace(/\r\n/g,'\n')!==source[key])throw Error(name+': drift '+key);}
  else text=text.replace(re,()=>source[key]);
 }
 if(!process.argv.includes('--check'))fs.writeFileSync(file,text);
}
console.log('GUI common source synchronized');
