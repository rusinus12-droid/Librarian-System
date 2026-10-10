'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),gatePath=path.join(__dirname,'libra_plugin_identity_test.cjs');
const source=fs.readFileSync(gatePath,'utf8'),pkgPath=path.join(root,'package.json'),lockPath=path.join(root,'package-lock.json');
const manifest=JSON.parse(fs.readFileSync(path.join(root,'src/build-manifest.json'),'utf8'));
const fullPath=path.join(root,manifest.output),minPath=path.join(root,manifest.minifiedOutput);
const pkg=JSON.parse(fs.readFileSync(pkgPath,'utf8')),version=pkg.version;
function fixture(next=version){
 const m=new Map();for(const p of [fullPath,minPath])m.set(p,fs.readFileSync(p,'utf8').replace(/^\/\/@version .+$/m,'//@version '+next).replace(/^\/\/@display-name .+$/m,'//@display-name LIBRA World Manager v'+next).replace('<span class="ver">v'+version+'</span>','<span class="ver">v'+next+'</span>'));
 const p={...pkg,version:next},lock=JSON.parse(fs.readFileSync(lockPath,'utf8'));lock.version=next;lock.packages[''].version=next;
 m.set(pkgPath,JSON.stringify(p));m.set(lockPath,JSON.stringify(lock));return m;
}
function execute(files){
 let report,exitCode;const fakeFs={...fs,readFileSync:(file,...args)=>files.has(String(file))?files.get(String(file)):fs.readFileSync(file,...args)};
 vm.runInNewContext(source,{require:name=>name==='fs'?fakeFs:require(name),__dirname,__filename:gatePath,process:{exit:n=>{exitCode=n}},console:{log:s=>{report=JSON.parse(s)}}});
 assert.equal(exitCode,report.ok?0:1);return report;
}
function check(name,files,expected,assertion){const r=execute(files);assert.equal(r.ok,expected,name+': '+r.assertions.filter(x=>!x.ok).map(x=>x.name));if(assertion)assert(r.assertions.some(x=>x.name===assertion&&!x.ok),name+' must fail intended contract');console.log('PASS '+name)}
check('current release',fixture(),true);
check('consistent changed release',fixture('99.2.3-beta.1'),true);
let f=fixture();f.set(minPath,f.get(minPath).replace(/^\/\/@version .+$/m,'//@version 99.2.3'));check('mismatched min header',f,false,'artifact_versions_match_package');
f=fixture();f.set(minPath,f.get(minPath).replace(/^\/\/@display-name .+$/m,'//@display-name LIBRA World Manager v99.2.3'));check('mismatched min display',f,false,'display_names_carry_current_version');
f=fixture();f.set(pkgPath,JSON.stringify({...pkg,version:'99.2.3'}));check('mismatched package version',f,false,'artifact_versions_match_package');
f=fixture();const lock=JSON.parse(f.get(lockPath));lock.version='99.2.3';f.set(lockPath,JSON.stringify(lock));check('mismatched lock version',f,false,'package_lock_matches_package_json');
f=fixture();f.set(fullPath,f.get(fullPath).replace('class="ver">v'+version,'class="ver">v99.2.3'));check('mismatched GUI version',f,false,'gui_brand_shows_new_name_and_version');
f=fixture();f.set(fullPath,f.get(fullPath).replace(/^\/\/@version .+\n/m,''));check('missing version header',f,false,'artifact_versions_match_package');
f=fixture();f.set(minPath,f.get(minPath).replace(/^\/\/@name .+$/m,'//@name wrong_plugin'));check('wrong plugin ID',f,false,'plugin_id_is_libra_world_manager');
f=fixture();f.set(minPath,f.get(minPath).replace(/^\/\/@update-url .+$/m,'//@update-url https://example.invalid/wrong.js'));check('wrong update path',f,false,'update_url_points_at_the_shipped_filename');
f=fixture();f.set(minPath,f.get(minPath).replace(/^\/\/@update-url .+$/m,'//@update-url https://example.invalid/PROGRAM/plugins/LIBRA_World_Manager.js'));check('wrong update host with matching filename',f,false,'update_url_points_at_the_shipped_filename');
f=fixture();f.set(minPath,f.get(minPath).replace('Librarian-System/refs/heads/main/PROGRAM/plugins/LIBRA_World_Manager.js','Librarian-System/refs/heads/dev/PROGRAM/plugins/LIBRA_World_Manager.js'));check('wrong update branch with matching filename',f,false,'update_url_points_at_the_shipped_filename');
