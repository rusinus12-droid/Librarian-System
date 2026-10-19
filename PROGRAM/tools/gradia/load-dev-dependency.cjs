'use strict';
const path=require('node:path');
const root=path.resolve(__dirname,'..');
module.exports=function loadDevDependency(name){
 let resolved;
 try { resolved=require.resolve(name,{paths:[root]}); }
 catch(error){
  let toolchain = process.env.GRADIA_TOOLCHAIN_ROOT;
  if (!toolchain) {
    try {
      const support = require('../ensure_build_support.cjs').ensureBuildSupportDependencies();
      if (support?.modulesDir) toolchain = support.modulesDir;
    } catch (_) {}
  }
  if (toolchain) {
    try { resolved = require.resolve(name, { paths: [path.resolve(toolchain)] }); }
    catch (_) { resolved = require.resolve(path.join(path.resolve(toolchain), name)); }
  } else {
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
