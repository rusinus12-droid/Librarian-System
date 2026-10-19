'use strict';
const path=require('node:path');
const root=path.resolve(__dirname,'..');
module.exports=function loadDevDependency(name){
 let resolved;
 try { resolved=require.resolve(name,{paths:[root]}); }
 catch(error){
  if(process.env.GRADIA_TOOLCHAIN_ROOT)resolved=require.resolve(path.join(path.resolve(process.env.GRADIA_TOOLCHAIN_ROOT),name));
  else {
   if (name === 'acorn') {
    try {
     const acorn = require('../build_plugins.cjs').resolveAcorn();
     if (acorn) return acorn;
    } catch (_) {}
   }
   throw new Error(`Missing development dependency ${name}. Install pinned devDependencies with npm ci, or set GRADIA_TOOLCHAIN_ROOT to an existing node_modules directory.`,{cause:error});
  }
 }
 return require(resolved);
};
