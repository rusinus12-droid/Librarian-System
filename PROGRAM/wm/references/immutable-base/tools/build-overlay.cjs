'use strict';
const fs=require('fs'),path=require('path'),Module=require('module'),crypto=require('crypto');
const root=path.resolve(__dirname,'..'),pins=JSON.parse(fs.readFileSync(root+'/BASE-PINS.json')),base=pins.base;
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
(async()=>{
 for(const item of pins.files)if(hash(fs.readFileSync(path.join(base,item.file)))!==item.sha256)throw Error('base_pin_changed:'+item.file);
 const virtualFs={...fs,readFileSync(file,...args){const rel=path.relative(base,String(file)),overlay=path.join(root,rel);return fs.readFileSync(!rel.startsWith('..')&&fs.existsSync(overlay)?overlay:file,...args);}};
 const factoryPath=base+'/tools/build-libra-runtime-factory.cjs';let source=fs.readFileSync(factoryPath,'utf8');if(fs.existsSync(__dirname+'/factory-edits.cjs'))source=require('./factory-edits.cjs')(source);
 const mod=new Module(factoryPath,module);mod.filename=factoryPath;mod.paths=Module._nodeModulePaths(path.dirname(factoryPath));const original=mod.require.bind(mod);mod.require=name=>name==='node:fs'?virtualFs:original(name);mod._compile(source,factoryPath);
 const coreRaw=fs.readFileSync(root+'/src/MemorySuiteSnapshotCache.cjs','utf8');if(hash(coreRaw)!=='f3f08f23ef873a5c0bf561b85c3271459cf908275a7d6e19f0448fa00ce3e1cc'||coreRaw.split('module.exports =').length!==2)throw Error('common_core_pin_changed');const coreLexical=coreRaw.replace('module.exports =','const MemorySuiteSnapshotCache =');
 let code=await mod.exports();if(fs.existsSync(root+'/src/versioned-canonical-bridge.source.js')){const seam='    const requireLoadedCharacter = async () => {';if(code.split(seam).length!==2)throw Error('bridge_seam_changed');code=code.replace(seam,'    const WmSnapshotAuthorityModule = (()=>{const module={exports:{}};\n'+fs.readFileSync(root+'/src/wm-versioned-snapshot.cjs','utf8')+'\nreturn module.exports;})();\n'+fs.readFileSync(root+'/src/versioned-canonical-bridge.source.js','utf8')+'\n    const WmSharedCacheFactory = () => {\n'+coreLexical+'\nreturn MemorySuiteSnapshotCache; };\n'+fs.readFileSync(root+'/src/wm-common-derived-cache.source.js','utf8')+'\n'+fs.readFileSync(root+'/src/wm-native-derived-cache.source.js','utf8')+'\n'+seam);}
 fs.writeFileSync(root+'/dist/LIBRA World Manager Full.js',code);
 const result={fullBytes:Buffer.byteLength(code),fullSha256:hash(code)};
 if(process.env.WM_BUILD_MIN==='1'){const {minify}=require('/workspace/scratch/d09f18a13aaa/min-verification-20261004T2120Z/toolchain/node_modules/terser');const min=await minify(code,{compress:{passes:2,negate_iife:false},mangle:false,format:{comments:/@(?:name|display-name|description|version|author|api|update-url|arg)\b|^!/}});if(!min.code)throw Error('minify_failed');const body=min.code+'\n';fs.writeFileSync(root+'/dist/LIBRA World Manager.js',body);Object.assign(result,{minBytes:Buffer.byteLength(body),minSha256:hash(body)});}
 console.log(JSON.stringify(result));
})().catch(e=>{console.error(e);process.exitCode=1;});
