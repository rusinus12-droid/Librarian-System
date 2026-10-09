'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const {versionFallbackMutation}=require('./libra_version_fallback_mutation.cjs');
const {functionExpression}=require('./libra_behavior_contract_helpers.cjs');
const root=path.resolve(__dirname,'..'),pkgPath=path.join(root,'package.json'),shellPath=path.join(root,'src/parts/00-plugin-shell-and-args.js'),debugPath=path.join(root,'src/parts/01d-debug-export-runtime-trace.js'),guiPath=path.join(root,'src/parts/15-gui-and-exports.js'),fullPath=path.join(root,'dist/LIBRA World Manager Full.js');
const pkg=JSON.parse(fs.readFileSync(pkgPath,'utf8')),current=pkg.version;
function fixture(next=current){
 const files=new Map();files.set(pkgPath,JSON.stringify({...pkg,version:next}));
 for(const p of [shellPath,guiPath,fullPath])files.set(p,fs.readFileSync(p,'utf8').replace(/^\/\/@version .+$/m,'//@version '+next).replace(/^\/\/@display-name .+$/m,'//@display-name LIBRA World Manager v'+next).replace('<span class="ver">v'+current+'</span>','<span class="ver">v'+next+'</span>'));
 const s=fs.readFileSync(debugPath,'utf8'),mutation=versionFallbackMutation(current);assert.equal(s.match(mutation.find)?.length>0,true,'current fallback anchor');
 files.set(debugPath,s.replace(mutation.find,"return '"+next+"';"));return files;
}
function execute(name,files){
 let report,exitCode=0;const gate=path.join(__dirname,name),fakeFs={...fs,readFileSync:(p,...args)=>files.has(String(p))?files.get(String(p)):fs.readFileSync(p,...args)};
 vm.runInNewContext(fs.readFileSync(gate,'utf8'),{URL,structuredClone,setTimeout,clearTimeout,setInterval,clearInterval,Buffer,TextEncoder,TextDecoder,AbortController,performance,require:n=>n==='fs'?fakeFs:require(n),__dirname,__filename:gate,process:{exit:n=>{exitCode=n}},console:{log:s=>{report=JSON.parse(s)}}});
 assert.equal(exitCode,report.ok?0:1);return report;
}
for(const version of [current,'99.2.3-beta.1']){
 const f=fixture(version);
 for(const gate of ['libra_gui_ux_integration_test.cjs','libra_settings_contract_test.cjs']){const r=execute(gate,f);assert.equal(r.ok,true,gate+' positive '+version+': '+JSON.stringify(r.assertions?.filter(a=>!a.ok)));console.log('PASS '+gate+' current/consistent '+version)}
 const mutation=versionFallbackMutation(version),src=f.get(debugPath);assert(mutation.find.test(src),'observed-version anchor matches');
 assert.equal(vm.runInNewContext('('+functionExpression(src,'PLUGIN_VERSION')+')',{LIBRA_PLUGIN_SHELL_HEADER:''}),version,'real version fallback baseline');
 f.set(debugPath,src.replace(mutation.find,mutation.replace));
 assert.equal(vm.runInNewContext('('+functionExpression(f.get(debugPath),'PLUGIN_VERSION')+')',{LIBRA_PLUGIN_SHELL_HEADER:''}),'0.1','real stale fallback mutation executes');
 const r=execute('libra_settings_contract_test.cjs',f);assert.equal(r.ok,false);assert(r.assertions.some(a=>a.name==='debug_export_version_not_stale'&&!a.ok),'correct stale version contract');console.log('PASS M6 stale fallback caught '+version);
 const badGui=fixture(version);badGui.set(guiPath,badGui.get(guiPath).replace('<span class="ver">v'+version+'</span>','<span class="ver">v0.1</span>'));
 assert.throws(()=>execute('libra_gui_ux_integration_test.cjs',badGui),/prototype_shell_header_and_left_rail_are_ported/);console.log('PASS GUI version mismatch caught '+version);
}
