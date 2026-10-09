'use strict';
// Original reviewed assertions are unchanged. Add the controlled fixture cache flag and anchor the five final-policy faults after backend release.
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const underlying=require('./integration-runtime.cjs');
const cacheEnabled=process.env.WM_DERIVED_FIXTURE_CACHE!=='0',finalBoundary=process.env.WM_FINAL_FAULT_BOUNDARY!=='first-observation';
const config={enabled:cacheEnabled,qualification:{kind:'test-fixture',reference:'reviewed-wm-tests-with-cache',version:'1'},budgets:{maxBytes:4*1024*1024,maxEntries:8,maxFlights:8,maxSubscribers:32,maxOwners:64,maxObservations:64,maxValueNodes:100000}};
const wrapped={...underlying,runtime:async(provider,options={})=>underlying.runtime(provider,{...options,transformCode(code){
 const seam='snapshotAuthority: globalThis.__SNAPSHOT_PROVIDER__';if(code.split(seam).length!==2)throw Error('cache_fixture_seam_changed');code=code.replace(seam,seam+', snapshotDerivedCache: '+JSON.stringify(config));return options.transformCode?options.transformCode(code):code;
}})};
for(const name of ['wm-versioned-integration.test.cjs','wm-native-boundary-parity.test.cjs','wm-mixed-scope-repair.test.cjs']){
 const file=path.join(__dirname,name),mod=new Module(file,module);mod.filename=file;mod.paths=Module._nodeModulePaths(__dirname);const original=mod.require.bind(mod);mod.require=id=>id==='./integration-runtime.cjs'?wrapped:original(id);let source=fs.readFileSync(file,'utf8');
 if(name==='wm-versioned-integration.test.cjs'){
  const start=source.indexOf("for(const fault of ['persona','branch','rollout','secret','blocklist'])"),end=source.indexOf("\ntest('dispose after sealed",start);
  if(start<0||end<0)throw Error('final_policy_fixture_seam_changed');const section=source.slice(start,end);
  if(section.split('if(armed&&!changed)').length!==2)throw Error('final_policy_guard_seam_changed');
  const guard=finalBoundary?'if(armed&&!changed&&p.activeLeases()===0)':'if(armed&&!changed)';
  const witness="console.log('WM_FINAL_FAULT_WITNESS '+JSON.stringify({fault,activeLeases:p.activeLeases(),cacheEnabled:"+JSON.stringify(cacheEnabled)+",boundary:"+JSON.stringify(finalBoundary?'post-release-final-observation':'first-observation')+"}));";
  source=source.slice(0,start)+section.replace('if(armed&&!changed){changed=true;',guard+'{'+witness+'changed=true;')+source.slice(end);
 }
 mod._compile(source,file);
}
