'use strict';
const path=require('node:path');
const root=path.resolve(__dirname,'..');
module.exports=function loadDevDependency(name){
 let resolved;
 try { resolved=require.resolve(name,{paths:[root]}); }
 catch(error){
  if(error.code!=='MODULE_NOT_FOUND')throw error;
  if(process.env.GRADIA_TOOLCHAIN_ROOT)resolved=require.resolve(path.join(path.resolve(process.env.GRADIA_TOOLCHAIN_ROOT),name));
  else throw new Error(`Missing development dependency ${name}. Install pinned devDependencies with npm ci, or set GRADIA_TOOLCHAIN_ROOT to an existing node_modules directory.`,{cause:error});
 }
 return require(resolved);
};
